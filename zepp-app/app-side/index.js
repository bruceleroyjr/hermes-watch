/*
 * Side Service: runs inside the Zepp app on the iPhone and forwards the watch's requests to
 * the watch relay on the PC over Tailscale (relay.js).
 * - binary envelope (recording) -> POST /watch/ask {audio_b64}
 * - confirm {id, yes}           -> POST /watch/confirm
 * - result {job}                -> POST /watch/result {job}
 * - last                        -> GET /watch/last (reply missed while the watch app was closed)
 * - newChat                     -> POST /watch/ask {text: 'start new session'} (New chat button)
 * Side Service fetch only sends string bodies, so audio goes as base64 in JSON.
 * ask and confirm carry a rid and are retried when the reply is lost (shared/retry.js).
 */
import { BaseSideService } from '@zeppos/zml/base-side'
import { parseEnvelope, base64 } from '../shared/envelope'
import { TOKEN, RELAY } from './token'
import { withRetry, newRid } from '../shared/retry'

const UNREACHABLE = "Can't reach the PC (is Tailscale on?)"
const RETRY = { tries: 3, budgetMs: 100000 } // the watch waits up to 150 s for ask/confirm

const errText = (e) => String(e && e.message ? e.message : e)

function parse(res) {
  try {
    return typeof res.body === 'string' ? JSON.parse(res.body) : res.body
  } catch (e) {
    return null
  }
}

async function call(method, path, payload) {
  const t0 = Date.now()
  try {
    const res = await fetch({
      url: `${RELAY}${path}`,
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    })
    const data = parse(res)
    if (res.status === 401) return { ok: false, error: 'The watch token was rejected by the PC.' }
    if (res.status !== 200 || !data) return { ok: false, error: `PC error ${res.status} (${path.split('?')[0]})` }
    return data
  } catch (e) {
    // The reason stays on screen so a failure can be traced from a photo of the watch.
    const why = `${path.split('?')[0]}: ${errText(e)} after ${Date.now() - t0} ms`
    console.log('fetch failed', why)
    return { ok: false, error: `${UNREACHABLE}\n[${why}]`, retry: true } // the watch retries polls on this
  }
}

function ask(buf) {
  let env
  try {
    env = parseEnvelope(buf)
  } catch (e) {
    return Promise.resolve({ ok: false, error: 'The recording got garbled on the way. Try again.' })
  }
  const payload = { audio_b64: base64(env.audio), rid: newRid() }
  return withRetry(() => call('POST', '/watch/ask', payload), RETRY)
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
        const payload = { id: p.id, yes: !!p.yes, rid: newRid() }
        work = withRetry(() => call('POST', '/watch/confirm', payload), RETRY)
      }
      else if (req.method === 'result') work = call('POST', '/watch/result', { job: p.job || '' })
      else if (req.method === 'last') work = call('GET', '/watch/last')
      else if (req.method === 'newChat') {
        const payload = { text: 'start new session', rid: newRid() }
        work = withRetry(() => call('POST', '/watch/ask', payload), RETRY)
      }
      else work = Promise.resolve({ ok: false, error: `unknown request ${req.method}` })
      work.then((r) => res(null, r)).catch((e) => res(null, { ok: false, error: errText(e) }))
    },
  }),
)
