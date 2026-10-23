/*
 * Side Service: runs inside the Zepp app on the iPhone and forwards the watch's requests to
 * the watch relay on the PC over Tailscale (relay.js).
 * - binary envelope (recording) -> POST /watch/ask {audio_b64}
 * - confirm {id, yes}           -> POST /watch/confirm
 * - result {job}                -> POST /watch/result {job}
 * - last                        -> GET /watch/last (reply missed while the watch app was closed)
 * - newChat                     -> POST /watch/ask {text: 'start new session'} (New chat button)
 * - speech {id}                 -> GET /watch/speech?id= (MP3), sent on to the watch as a file
 * - diag {events}               -> POST /watch/diag (only when shared/debug.js DIAG is on)
 * ask/confirm/result carry speak: true while Voice is on, so replies come with a speech id; the
 * phone starts fetching and sending that audio itself as the reply passes through (saves a
 * watch->phone round trip), and the watch's own `speech` request just waits for the same job.
 * Side Service fetch only sends string bodies, so audio goes as base64 in JSON.
 * Lost replies are retried by the watch only (it owns the rid and resends after 25 s, 70 s for
 * Yes/No; iOS pauses this service's timers while the phone is locked). Here each request is one
 * attempt; no reply within its limit comes back as {retry: true}, which the watch resends.
 */
import { BaseSideService } from '@zeppos/zml/base-side'
import { parseEnvelope, base64 } from '../shared/envelope'
import { TOKEN, RELAY } from './token'
import { newRid, withTimeout } from '../shared/retry'
import { onceBy } from '../shared/once'
import { DIAG } from '../shared/debug'

const speechJobs = new Map() // speech id -> promise of {ok, error?}: each answer is fetched and sent once

const UNREACHABLE = "Can't reach the PC (is Tailscale on?)"

// Just under the watch's own resend times (25 s / 70 s), so when this service's timer does run,
// the watch hears {retry: true} and resends at once instead of waiting out its own timer.
const ASK_MS = 20000
const CONFIRM_MS = 65000 // Yes/No can legitimately take up to a minute (sending a text, waking the car)
const POLL_MS = 15000

const errText = (e) => String(e && e.message ? e.message : e)

function parse(res) {
  try {
    return typeof res.body === 'string' ? JSON.parse(res.body) : res.body
  } catch (e) {
    return null
  }
}

async function call(method, path, payload, limitMs = ASK_MS) {
  const t0 = Date.now()
  try {
    const res = await withTimeout(fetch({
      url: `${RELAY}${path}`,
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }), limitMs, () => null)
    if (!res) {
      const why = `${path.split('?')[0]}: no reply after ${Date.now() - t0} ms`
      console.log('fetch lost', why)
      return { ok: false, error: `${UNREACHABLE}\n[${why}]`, retry: true }
    }
    const data = parse(res)
    if (res.status === 401) return { ok: false, error: 'The watch token was rejected by the PC.' }
    if (res.status !== 200 || !data) return { ok: false, error: `PC error ${res.status} (${path.split('?')[0]})` }
    return data
  } catch (e) {
    // The reason stays on screen so a failure can be traced from a photo of the watch.
    const why = `${path.split('?')[0]}: ${errText(e)} after ${Date.now() - t0} ms`
    console.log('fetch failed', why)
    return { ok: false, error: `${UNREACHABLE}\n[${why}]`, retry: true } // the watch resends on this
  }
}

function ask(buf) {
  let env
  try {
    env = parseEnvelope(buf)
  } catch (e) {
    return Promise.resolve({ ok: false, error: 'The recording got garbled on the way. Try again.' })
  }
  return call('POST', '/watch/ask', { audio_b64: base64(env.audio), rid: env.header.rid || newRid(), speak: !!env.header.speak })
}

// Short status lines into the relay log (POST /watch/diag), because this side service's own
// console can't be read from the PC. Only with DIAG on; fire and forget.
function diag(from, ...events) {
  if (!DIAG) return
  try {
    fetch({ url: `${RELAY}/watch/diag`, method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ from, events }) }).catch(() => {})
  } catch (e) {}
}

// Downloaded MP3s are kept under a few rotating names, so they don't pile up in the Zepp app
// (the side service can't delete files). If overwriting one ever fails, a one-off name is used.
const SPEECH_SLOTS = 3
let speechSlot = 0

// Spoken answer: download the MP3 from the relay, then send it to the watch (zml file transfer).
// Resolves when the watch has it, so a failure can be shown on the watch.
function sendSpeech(svc, id, trigger) {
  const t0 = Date.now()
  const step = (what) => diag('phone', `speech ${id}: ${what} (+${Date.now() - t0} ms)`)
  step(`start (${trigger})`)
  return new Promise((resolve) => {
    let settled = false
    let task = null
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      step(r.ok ? 'done' : `failed: ${r.error}`)
      resolve(r)
    }
    const timer = setTimeout(() => {
      try {
        if (task && task.cancel) task.cancel() // don't send a file the watch has given up on
      } catch (e) {}
      done({ ok: false, error: 'Voice: timed out sending the audio to the watch.' })
    }, 90000)
    const start = (file, fallback) => {
      try {
        task = svc.download(`${RELAY}/watch/speech?id=${encodeURIComponent(id)}`,
          { timeout: 40000, headers: { Authorization: `Bearer ${TOKEN}` }, filePath: file })
      } catch (e) {
        return fallback ? start(fallback) : done({ ok: false, error: `Voice download didn't start: ${errText(e)}` })
      }
      task.onFail = (ev) => {
        if (settled) return
        if (fallback) {
          step(`download to ${file} failed (${ev && ev.code}), trying a one-off name`)
          return start(fallback)
        }
        done({ ok: false, error: `Voice download failed: ${ev && ev.code} ${ev && ev.message}` })
      }
      task.onSuccess = (ev) => {
        if (settled) return
        step(`downloaded, HTTP ${ev.statusCode}`)
        if (ev.statusCode !== 200) return done({ ok: false, error: `Voice: the PC answered ${ev.statusCode}.` })
        try {
          const sent = svc.sendFile(ev.filePath || ev.tempFilePath || file, { type: 'speech', id })
          step('handed to Bluetooth')
          sent.on('change', (e) => {
            const state = e && e.data && e.data.readyState
            step(`transfer ${state}`)
            if (state === 'transferred') done({ ok: true, sent: true })
            else if (state === 'error' || state === 'canceled') done({ ok: false, error: `Voice: sending to the watch ${state}.` })
          })
        } catch (e) {
          done({ ok: false, error: `Voice: ${errText(e)}` })
        }
      }
    }
    speechSlot = (speechSlot + 1) % SPEECH_SLOTS
    start(`data://download/hermes-speech-${speechSlot}.mp3`, `data://download/hermes-${id}.mp3`)
  })
}

AppSideService(
  BaseSideService({
    onInit() {},
    onRun() {},
    onDestroy() {},
    onRequest(req, res) {
      const isBinary = req instanceof ArrayBuffer || (req && req.byteLength !== undefined && !req.method)
      const p = req && req.params ? req.params : {}
      let work
      if (isBinary) work = ask(req)
      else if (req.method === 'confirm') {
        work = call('POST', '/watch/confirm', { id: p.id, yes: !!p.yes, rid: p.rid || newRid(), speak: !!p.speak }, CONFIRM_MS)
      }
      else if (req.method === 'result') work = call('POST', '/watch/result', { job: p.job || '', speak: !!p.speak }, POLL_MS)
      else if (req.method === 'speech') work = onceBy(speechJobs, String(p.id || ''), () => sendSpeech(this, String(p.id || ''), 'watch asked'))
      else if (req.method === 'diag') {
        diag('watch', ...(Array.isArray(p.events) ? p.events : []))
        work = Promise.resolve({ ok: true })
      }
      else if (req.method === 'last') work = call('GET', '/watch/last', null, POLL_MS)
      else if (req.method === 'newChat') work = call('POST', '/watch/ask', { text: 'start new session', rid: p.rid || newRid() })
      else work = Promise.resolve({ ok: false, error: `unknown request ${req.method}` })
      work.then((r) => {
        res(null, r) // the text goes to the watch first...
        if (r && r.speech) onceBy(speechJobs, r.speech, () => sendSpeech(this, r.speech, `reply to ${req.method || 'ask'}`)) // ...then its audio follows
      }).catch((e) => res(null, { ok: false, error: errText(e) }))
    },
  }),
)
