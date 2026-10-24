/*
 * Hermes on the watch: tap TALK, speak, tap STOP (stops by itself at 90 s). The recording
 * goes through the Zepp app on the phone to the PC (relay.js), which answers
 * with Hermes's reply, a Yes/No card for texts, emails and car commands, or a job id when
 * Hermes is slow (polled every 3 s for up to 10 min). Long answers scroll.
 * The watch closes the app when the screen times out; the current screen is saved and comes
 * back on reopen, and a reply that arrived meanwhile is fetched from the relay (/watch/last).
 * GPS is on the whole time the app is open (a cold fix needs 30 s or more, and
 * switching off after each question left follow-ups without one); each question carries the
 * latest fix (shared/location.js) so Hermes knows where the user is.
 */
import * as hmUI from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { create, id, codec } from '@zos/media'
import { statSync, openSync, readSync, closeSync, rmSync, O_RDONLY } from '@zos/fs'
import { queryPermission, requestPermission } from '@zos/app'
import { scrollTo } from '@zos/page'
import { localStorage } from '@zos/storage'
import { setPageBrightTime, resetPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff } from '@zos/display'
import { Vibrator, Geolocation } from '@zos/sensor'
import { BasePage } from '@zeppos/zml/base-page'
import { buildEnvelope } from '../shared/envelope'
import { untilPhoneWakes, phoneError, resendUntil, newRid, uploadAllowanceMs, ASK_ATTEMPT_MS, confirmAttemptMs } from '../shared/retry'
import { screenFor, pollStep, resumeFor, lastIsNew } from '../shared/screens'
import { ringDots, dotColors, elapsedText, dotsText } from '../shared/spinner'
import { DIAG } from '../shared/debug'
import { speechQueue } from '../shared/speechqueue'
import { pieceRanges } from '../shared/pieces'
import { makeFix, locationFor } from '../shared/location'

const FILE = 'clip.opus'
const TRACE = 'close-trace'
const MAX_REC_MS = 90000 // long questions are fine; the upload gets extra time (uploadAllowanceMs)
const POLL_MS = 3000
// A poll with no reply or error after this is abandoned and sent again: one once never ended (no
// timeout fired), and every later tick was skipped - the watch sat on Still working for 6 min while
// the answer waited on the PC.
const POLL_STUCK_MS = 25000
const WAKE_MS = 30000 // keep retrying while iOS wakes the Zepp app ("shake timeout")
const OPEN_ZEPP = 'Open the Zepp app on your iPhone'
// A request with no reply after ASK_ATTEMPT_MS / confirmAttemptMs (shared/retry.js) was lost between
// the PC and the iPhone: the watch sends it again with the same request id.
const PIECE_TRIES = 4 // a piece of a long recording that failed or got no reply is sent again
const REQUEST_BUDGET_MS = 150000
const POLL_LIMIT_MS = 10 * 60 * 1000
const WAIT_BRIGHT_MS = 10 * 60 * 1000 // screen stays on while recording and waiting
const READ_BRIGHT_MS = 60 * 1000 // then a minute to read the answer
const MIC = 'device:os.mic'
const GEO = 'device:os.geolocation'
const LAST_FIX = 'last-fix' // survives closing the app, for a question asked before GPS has a fix
const GEO_ASKED = 'geo-asked' // the location permission is asked once, on open, never while recording
const SAVED = 'last-screen'
const VOICE_KEY = 'voice' // 'off' when the Voice button is switched off; on by default
const LAST_TRIES = 6 // x 3 s: the relay answers or hands out a job within 12 s
const GRANTED = 2

const { width: W, height: H } = getDeviceInfo()
const MARGIN = Math.round(W * 0.12)
const TEXT_W = W - 2 * MARGIN
const GREEN = 0x1e8449
const GREY = 0x5d6d7e
const BLUE = 0x2471a3
const VOICE_W = 158 // = round(466 * 0.34), the voice icon images' width

// Waiting animation: a ring of dots round the screen edge with a chasing head (shared/spinner.js).
const RING_N = 16
const RING = ringDots(RING_N, Math.round(W / 2), Math.round(H / 2), Math.round(W / 2) - 18)
const DOT_R = 7
const SPIN = {
  thinking: { head: 0x7fd4ff, dim: 0x13222c, tickMs: 70, label: 'Thinking' },
  working: { head: 0xf5b041, dim: 0x2a1f0e, tickMs: 130, label: 'Still working' },
}

const errText = (e) => (e && e.message ? e.message : String(e))

function vibrate() {
  try {
    new Vibrator().start()
  } catch (e) {}
}

function withMic(onGranted, onDenied) {
  let status
  try {
    status = queryPermission({ permissions: [MIC] })[0]
  } catch (e) {
    return onGranted() // no permission API on this firmware: the recorder reports instead
  }
  if (status === GRANTED) return onGranted()
  const result = requestPermission({
    permissions: [MIC],
    callback: () => {
      let now = null
      try {
        now = queryPermission({ permissions: [MIC] })[0]
      } catch (e) {}
      if (now === GRANTED) onGranted()
      else onDenied('The microphone is not allowed. Answer Allow on the watch.')
    },
  })
  if (result === GRANTED) onGranted()
  else if (result === 1) onDenied('The microphone is blocked. Allow it for Hermes in the watch settings.')
}

// Location is optional: anything but a clear "allowed" just means questions go without it.
function geoAllowed() {
  try {
    return queryPermission({ permissions: [GEO] })[0] === GRANTED
  } catch (e) {
    return true // no permission API on this firmware: try the sensor
  }
}

function askGeoOnce() {
  try {
    if (geoAllowed() || localStorage.getItem(GEO_ASKED, '')) return
    localStorage.setItem(GEO_ASKED, '1')
    requestPermission({ permissions: [GEO], callback: () => {} })
  } catch (e) {}
}

function clipSize() {
  const st = statSync({ path: FILE })
  return (st && st.size) || 0
}

// One piece of the recording, read when it is sent: only ~24 KB of the clip is in memory at a time.
function readPiece({ start, length }) {
  const fd = openSync({ path: FILE, flag: O_RDONLY })
  try {
    const buf = new ArrayBuffer(length)
    const got = readSync({ fd, buffer: buf, options: { position: start } })
    if (got !== length) throw new Error(`read ${got} of ${length} bytes`)
    return buf
  } finally {
    closeSync(fd)
  }
}

function textHeight(text, size) {
  if (!text) return 0
  try {
    return hmUI.getTextLayout(text, { text_size: size, text_width: TEXT_W, wrapped: 1 }).height + 8
  } catch (e) {
    return Math.ceil(text.length / 22) * (size + 8)
  }
}

Page(
  BasePage({
    state: { widgets: [], recorder: null, recording: false, busy: false, startedAt: 0, timers: [], poll: null, renderTimer: null, anim: null, waitSince: 0, resumeToken: 0,
      voiceOn: true, player: null, playerReady: false, playing: false, speechId: null, speechFile: null, earlyFiles: [], queue: null,
      gps: null, gpsOnChange: null, fix: null, gpsNote: '' },

    build() {
      this.state.player = null // each page gets its own player
      this.state.playerReady = false
      this.state.playing = false
      this.state.gps = null
      this.state.fix = null
      askGeoOnce()
      this.startGps() // stays on until the app closes
      try {
        this.state.voiceOn = localStorage.getItem(VOICE_KEY, 'on') !== 'off'
      } catch (e) {}
      try {
        getApp()._options.globalData.onSpeechFile = (path, params) => this.playSpeech(path, params)
        getApp()._options.globalData.onSpeechNote = (note) => this.report(note)
      } catch (e) {}
      if (DIAG) {
        try {
          const last = localStorage.getItem(TRACE, 'none')
          this.state.timers.push(setTimeout(() => this.report(`last close: ${last}`), 2000)) // once the phone link is up
        } catch (e) {}
      }
      let saved = null
      try {
        saved = JSON.parse(localStorage.getItem(SAVED, '') || 'null')
      } catch (e) {}
      const r = resumeFor(saved, Date.now())
      if (!r) return this.show({ screen: 'idle' })
      if (r.show) {
        this.keepAwake(READ_BRIGHT_MS)
        return this.show(r.show)
      }
      this.fetchLast(r.fetchLast, r.heard)
    },

    // Reopened while a question was out: collect the reply the relay kept for us.
    fetchLast(since, heard) {
      this.state.busy = true
      this.state.waitSince = since
      this.keepAwake(WAIT_BRIGHT_MS)
      this.show({ screen: 'thinking', heard, resume: true }) // has a Cancel button: a dead phone can't trap the app
      const token = ++this.state.resumeToken
      let tries = 0
      const attempt = () => {
        this.request({ method: 'last' }, { timeout: 20000 }) // one try each: no 30 s phone wake-up wait here
          .catch(() => null)
          .then((last) => {
            if (token !== this.state.resumeToken) return // cancelled

            if (lastIsNew(last, since, Date.now())) {
              const reply = !last.heard && heard ? { ...last, heard: heard.replace(/^You said: /, '') } : last
              return this.finish(reply)
            }
            if (++tries < LAST_TRIES) return this.state.timers.push(setTimeout(attempt, POLL_MS))
            this.finish(last && !last.ok ? last : { ok: false, error: "That question didn't reach Hermes. Tap TALK to ask again." })
          })
      }
      attempt()
    },

    onDestroy() {
      this.trace('closing')
      this.stopVoice() // normally already released when the last clip finished
      this.trace('player closed')
      this.stopGps() // never leave the app holding a sensor (the speaker rebooted the watch that way)
      this.trace('gps closed')
      try {
        getApp()._options.globalData.onSpeechFile = null
        getApp()._options.globalData.onSpeechNote = null
      } catch (e) {}
      this.stopAnim()
      this.clearTimers()
      try {
        if (this.state.recording) this.state.recorder.stop()
      } catch (e) {}
      resetPageBrightTime()
      resetDropWristScreenOff()
      this.trace('closed')
    },

    // Reboot hunt (DIAG only): the last step of the previous close survives a reboot in
    // localStorage, and the next open reports it to the PC log.
    trace(step) {
      if (!DIAG) return
      try {
        localStorage.setItem(TRACE, `${new Date().toISOString()} ${step}`)
      } catch (e) {}
    },

    // ------------------------------------------------------------------ location
    startGps() {
      if (this.state.gps) return
      if (!geoAllowed()) {
        this.state.gpsNote = 'location not allowed'
        return
      }
      try {
        const geo = new Geolocation()
        try {
          if (geo.getEnabled && geo.getEnabled() === false) {
            this.state.gpsNote = 'location is off in the watch settings'
            return
          }
        } catch (e) {}
        const onChange = () => {
          try {
            if (geo.getStatus() !== 'A') return
            const fix = makeFix(geo.getLatitude({ format: 'DD' }), geo.getLongitude({ format: 'DD' }), Date.now())
            if (!fix) return
            this.state.fix = fix
            localStorage.setItem(LAST_FIX, JSON.stringify(fix))
          } catch (e) {}
        }
        geo.onChange(onChange)
        geo.start()
        this.state.gps = geo
        this.state.gpsOnChange = onChange
        this.state.gpsNote = ''
        onChange() // already fixed if another app had GPS on
      } catch (e) {
        this.state.gpsNote = `GPS error: ${errText(e)}`
      }
    },

    stopGps() {
      const geo = this.state.gps
      if (!geo) return
      if (this.state.gpsOnChange) this.state.gpsOnChange() // the latest fix, before it goes off
      this.state.gps = null
      try {
        geo.offChange(this.state.gpsOnChange)
      } catch (e) {}
      try {
        geo.stop()
      } catch (e) {}
      this.state.gpsOnChange = null
    },

    // {loc} for the question's header, or {gps: why not} so the PC log says why there was none.
    whereAmI() {
      if (this.state.gpsOnChange) this.state.gpsOnChange() // the very latest fix, in case no change event came
      let fix = this.state.fix
      if (!fix) {
        try {
          fix = JSON.parse(localStorage.getItem(LAST_FIX, '') || 'null')
        } catch (e) {}
      }
      const loc = locationFor(fix, Date.now())
      if (loc) return { loc }
      return { gps: this.state.gpsNote || (fix ? 'last fix too old' : 'no fix yet') }
    },

    // ------------------------------------------------------------------ screens
    // Rebuilt after the current click handler returns: deleting the pressed button inside
    // its own callback would crash the page.
    show(model) {
      this.model = model
      this.save(model)
      if (this.state.renderTimer) return
      this.state.renderTimer = setTimeout(() => {
        this.state.renderTimer = null
        this.render(this.model)
      }, 10)
    },

    // Remembered for the next time the app opens; recording is never resumed (the screen it
    // started from stays saved), and the start screen clears it.
    save(model) {
      if (model.screen === 'listening') return
      try {
        if (model.screen === 'idle') return localStorage.removeItem(SAVED)
        localStorage.setItem(SAVED, JSON.stringify({ at: Date.now(), since: this.state.waitSince, model }))
      } catch (e) {}
    },

    add(type, props) {
      const w = hmUI.createWidget(type, props)
      this.state.widgets.push(w)
      return w
    },

    text(y, text, size, color) {
      const h = textHeight(text, size)
      this.add(hmUI.widget.TEXT, {
        x: MARGIN, y, w: TEXT_W, h, text, text_size: size, color,
        align_h: hmUI.align.CENTER_H, text_style: hmUI.text_style.WRAP,
      })
      return y + h
    },

    button(y, text, color, onClick, w = Math.round(W * 0.5), x = Math.round((W - w) / 2)) {
      this.add(hmUI.widget.BUTTON, {
        x, y, w, h: 80, radius: 40, text, text_size: 30, normal_color: color, press_color: 0x333333,
        click_func: onClick,
      })
      return y + 80
    },

    render(m) {
      this.stopAnim()
      for (const w of this.state.widgets) hmUI.deleteWidget(w)
      this.state.widgets = []
      const talk = () => this.onTalk()
      let y = Math.round(H * 0.1)
      if (m.screen === 'idle') {
        this.add(hmUI.widget.IMG, { x: Math.round((W - 124) / 2), y: Math.round(H * 0.08), src: 'icon.png' })
        y = this.text(Math.round(H * 0.36), m.note || 'Tap TALK and ask Hermes', 26, 0xffffff)
        y = this.button(y + 20, 'TALK', GREEN, talk)
        this.voiceButton(y + 16)
      } else if (m.screen === 'listening') {
        y = this.text(Math.round(H * 0.3), `Listening... ${m.seconds || 0}s`, 34, 0x7fd4ff)
        this.button(y + 30, 'STOP', 0xc0392b, talk)
      } else if (m.screen === 'thinking' || m.screen === 'working') {
        this.renderWaiting(m)
      } else if (m.screen === 'confirm') {
        y = this.text(y + 20, m.heard, 24, 0x999999)
        y = this.text(y + 10, m.text, 32, 0xffffff)
        if (m.voiceNote) y = this.text(y + 6, m.voiceNote, 20, 0xf5b041)
        const bw = Math.round(W * 0.32)
        const gap = 16
        const left = Math.round((W - 2 * bw - gap) / 2)
        // Approve cards are Hermes asking for approval (Claude Code changes); Approve = this one time.
        const [yes, no] = m.approve ? ['Approve', 'Deny'] : ['Yes', 'No']
        this.button(y + 24, yes, GREEN, () => this.confirm(m.id, true, yes, m), bw, left)
        this.button(y + 24, no, GREY, () => this.confirm(m.id, false, no, m), bw, left + bw + gap)
        y += 24 + 80
        // Any other answer is spoken: it goes to Hermes as the next message and the card lapses.
        y = this.button(y + 16, 'Reply', BLUE, talk, 2 * bw + gap, left)
        this.add(hmUI.widget.TEXT, { x: 0, y: y + 60, w: W, h: 2, text: '' }) // scroll room
      } else {
        // answer / error
        y = this.text(y + 20, m.heard, 24, 0x999999)
        y = this.text(y + 10, m.text, 32, m.screen === 'error' ? 0xff7b6b : 0xffffff)
        if (m.voiceNote) y = this.text(y + 6, m.voiceNote, 20, 0xf5b041)
        y = this.button(y + 30, 'TALK', GREEN, talk)
        // TALK continues the conversation; New chat drops it (Hermes forgets the earlier turns).
        const bw = Math.round(W * 0.34)
        const gap = 12
        const left = Math.round((W - 2 * bw - gap) / 2)
        this.button(y + 16, 'New chat', GREY, () => this.newChat(), bw, left)
        y = this.voiceButton(y + 16, left + bw + gap)
        this.add(hmUI.widget.TEXT, { x: 0, y: y + Math.round(H * 0.2), w: W, h: 2, text: '' }) // scroll room
      }
      try {
        scrollTo({ y: 0 })
      } catch (e) {}
    },

    // Thinking / Still working: spinning ring, Hermes icon, label with cycling dots, time waited.
    renderWaiting(m) {
      const spin = SPIN[m.screen]
      const dots = RING.map((p) => this.add(hmUI.widget.CIRCLE, { center_x: p.x, center_y: p.y, radius: DOT_R, color: spin.dim }))
      this.add(hmUI.widget.IMG, { x: Math.round((W - 124) / 2), y: 72, src: 'icon.png' })
      const label = this.add(hmUI.widget.TEXT, {
        x: MARGIN, y: 206, w: TEXT_W, h: 44, text: `${spin.label}.`, text_size: 32, color: spin.head,
        align_h: hmUI.align.CENTER_H,
      })
      const since = this.state.waitSince || Date.now()
      const clock = this.add(hmUI.widget.TEXT, {
        x: MARGIN, y: 252, w: TEXT_W, h: 30, text: elapsedText(Date.now() - since), text_size: 22, color: 0x888888,
        align_h: hmUI.align.CENTER_H,
      })
      const heard = (m.heard || '').length > 70 ? `${m.heard.slice(0, 67)}...` : m.heard || ''
      let y = 286
      if (heard) y = this.text(y, heard, 20, 0x999999)
      if (m.note) y = this.text(y, m.note, 20, SPIN.working.head) // "you can close the app" after an Approve
      if (m.screen === 'working' || m.resume) this.button(Math.max(y + 8, 326), 'Cancel', GREY, () => this.cancelPoll(), Math.round(W * 0.4))
      let step = 0
      let shown = ''
      this.state.anim = setInterval(() => {
        step++
        const colors = dotColors(step, RING_N, spin.head, spin.dim, 6)
        for (let i = 0; i < RING_N; i++) {
          dots[i].setProperty(hmUI.prop.MORE, { center_x: RING[i].x, center_y: RING[i].y, radius: DOT_R, color: colors[i] })
        }
        if (step % 6 === 0) label.setProperty(hmUI.prop.TEXT, `${this.state.waking ? 'Waking the phone' : spin.label}${dotsText(step / 6)}`)
        const t = elapsedText(Date.now() - since)
        if (t !== shown) clock.setProperty(hmUI.prop.TEXT, (shown = t))
      }, spin.tickMs)
    },

    stopAnim() {
      if (this.state.anim) clearInterval(this.state.anim)
      this.state.anim = null
    },

    // ------------------------------------------------------------------ recording
    clearTimers() {
      for (const t of this.state.timers) {
        clearTimeout(t)
        clearInterval(t)
      }
      this.state.timers = []
      if (this.state.poll) clearInterval(this.state.poll)
      this.state.poll = null
    },

    keepAwake(ms) {
      try {
        setPageBrightTime({ brightTime: ms })
        pauseDropWristScreenOff({ duration: 0 })
      } catch (e) {}
    },

    onTalk() {
      if (this.state.busy) return
      if (this.state.recording) return this.stopAndSend()
      this.stopVoice() // don't record Hermes talking
      this.state.speechId = null
      withMic(() => this.startRecording(), (why) => this.show({ screen: 'error', heard: '', text: why }))
    },

    startRecording() {
      try {
        try {
          rmSync({ path: FILE })
        } catch (e) {}
        if (!this.state.recorder) this.state.recorder = create(id.RECORDER)
        this.state.recorder.setFormat(codec.OPUS, { target_file: `data://${FILE}` })
        this.state.recorder.start()
        this.startGps() // no-op unless it failed to start on open
      } catch (e) {
        return this.show({ screen: 'error', heard: '', text: `Could not start the microphone: ${errText(e)}` })
      }
      this.clearTimers()
      this.keepAwake(WAIT_BRIGHT_MS)
      vibrate()
      this.state.recording = true
      this.state.startedAt = Date.now()
      this.show({ screen: 'listening', seconds: 0 })
      this.state.timers.push(setInterval(() => {
        this.show({ screen: 'listening', seconds: Math.round((Date.now() - this.state.startedAt) / 1000) })
      }, 1000))
      this.state.timers.push(setTimeout(() => this.stopAndSend(), MAX_REC_MS))
    },

    stopAndSend() {
      if (!this.state.recording) return
      this.clearTimers()
      this.state.recording = false
      this.state.busy = true
      try {
        this.state.recorder.stop()
      } catch (e) {}
      vibrate()
      this.state.waitSince = Date.now()
      this.show({ screen: 'thinking', heard: '' })
      // Give the recorder a moment to finish writing the file.
      this.state.timers.push(setTimeout(() => this.send(), 400))
    },

    send() {
      let size
      try {
        size = clipSize()
      } catch (e) {
        return this.finish({ ok: false, error: `Could not read the recording: ${errText(e)}` })
      }
      if (!size) return this.finish({ ok: false, error: 'Nothing was recorded. Try again.' })
      // Long recordings go in pieces (shared/pieces.js); the last piece is the question itself.
      // Each piece is read from the file just before it is sent, and only while it is sent.
      const rid = newRid()
      const ranges = pieceRanges(size)
      const n = ranges.length
      const opts = { contentType: 'bin', dataType: 'json' }
      const where = this.whereAmI() // only the last piece (the question itself) needs it
      const envelope = (i) => buildEnvelope({ kind: 'ask', speak: this.state.voiceOn, rid, ...(n > 1 ? { part: i + 1, parts: n } : {}),
        ...(i === n - 1 ? where : {}) }, readPiece(ranges[i]))
      const piece = (i, tries = 1) => {
        this.show({ screen: 'thinking', heard: `Sending ${i + 1} of ${n}` })
        const extra = uploadAllowanceMs(ranges[i].length)
        return Promise.resolve().then(() => this.phoneRequest(envelope(i), { ...opts, timeout: ASK_ATTEMPT_MS + extra }))
          .then((r) => (r && r.ok ? r : Promise.reject(new Error((r && r.error) || 'no reply'))))
          .catch((e) => {
            if (tries >= PIECE_TRIES || /shake timeout/i.test(errText(e))) throw e // phoneRequest already waited 30 s
            return new Promise((resolve) => setTimeout(resolve, 1000)).then(() => piece(i, tries + 1))
          })
      }
      const ask = () => {
        if (n > 1) this.show({ screen: 'thinking', heard: `Sending ${n} of ${n}` })
        const extra = uploadAllowanceMs(ranges[n - 1].length)
        return this.resendRequest(envelope(n - 1), opts, ASK_ATTEMPT_MS + extra, REQUEST_BUDGET_MS + 2 * extra)
      }
      let chain = Promise.resolve()
      for (let i = 0; i < n - 1; i++) chain = chain.then(() => piece(i))
      chain.then(ask)
        .then((r) => this.finish(r))
        .catch((e) => this.finish({ ok: false, error: phoneError(e) }))
    },

    // ------------------------------------------------------------------ replies
    finish(reply) {
      const m = screenFor(reply)
      if (m.screen === 'working') return this.startPoll(m)
      this.state.busy = false
      this.keepAwake(READ_BRIGHT_MS)
      if (m.screen !== 'working') vibrate()
      this.show(m)
      if (m.screen === 'answer' || m.screen === 'confirm') this.report(`${m.screen}: speech ${m.speech || 'none'}, voice ${this.state.voiceOn ? 'on' : 'off'}`)
      if (m.speech && this.state.voiceOn) this.speak(m.speech, m.speechParts || 1) // text first; the voice follows
    },

    // A status line into the PC's relay log (via the phone), only with shared/debug.js DIAG on.
    report(...events) {
      if (!DIAG) return
      try {
        this.request({ method: 'diag', params: { events } }, { timeout: 10000 }).catch(() => {})
      } catch (e) {}
    },

    // ------------------------------------------------------------------ voice
    // A speaker icon instead of words: sound waves = Voice on, an X = off (images drawn by
    // tools/voice-icons.py at VOICE_W x 80, the size of the New chat button beside it).
    voiceButton(y, x = Math.round((W - VOICE_W) / 2)) {
      const icon = this.state.voiceOn ? 'voice-on' : 'voice-off'
      this.add(hmUI.widget.BUTTON, {
        x, y, w: VOICE_W, h: 80, normal_src: `${icon}.png`, press_src: `${icon}-press.png`,
        click_func: () => this.toggleVoice(),
      })
      return y + 80
    },

    toggleVoice() {
      this.state.voiceOn = !this.state.voiceOn
      try {
        localStorage.setItem(VOICE_KEY, this.state.voiceOn ? 'on' : 'off')
      } catch (e) {}
      if (!this.state.voiceOn) this.stopVoice()
      this.show({ ...this.model, voiceNote: '' }) // redraw the button
    },

    // Ask the phone to fetch the MP3 clip(s) and send them here; each plays when its file arrives
    // (app.js), in order: a long answer is the first sentence, then the rest (shared/speechqueue.js).
    speak(speechId, parts = 1) {
      this.state.speechId = speechId
      this.state.queue = speechQueue(parts)
      // The phone pushes the audio on its own, so it can arrive before this answer was shown.
      const early = this.state.earlyFiles.filter((f) => f.id === speechId)
      this.state.earlyFiles = this.state.earlyFiles.filter((f) => f.id !== speechId)
      for (const f of early) this.playSpeech(f.path, { id: speechId, part: f.part })
      this.phoneRequest({ method: 'speech', params: { id: speechId, parts } }, { timeout: 120000 })
        .then((r) => {
          this.report(`speech ${speechId}: watch request -> ${r && r.ok ? 'ok' : (r && r.error) || 'no reply'}`)
          if (r && !r.ok && this.state.speechId === speechId) this.voiceProblem(r.error)
        })
        .catch((e) => {
          this.report(`speech ${speechId}: watch request failed: ${errText(e)}`)
          this.voiceProblem(`Voice: ${phoneError(e)}`)
        })
    },

    playSpeech(path, params) {
      const pid = params && params.id
      const part = Number(params && params.part) || 1
      const skip = !this.state.voiceOn ? 'voice off' : this.state.recording ? 'recording'
        : pid !== this.state.speechId || !this.state.queue ? `waiting for ${this.state.speechId}` : ''
      this.report(`speech ${pid}.${part}: file arrived ${path}${skip ? ` - not now (${skip})` : ''}`)
      if (skip) {
        if (this.state.voiceOn && !this.state.recording && pid) {
          // Not shown yet: keep it (newest few) for speak(); drop the oldest.
          this.state.earlyFiles.push({ id: pid, part, path })
          while (this.state.earlyFiles.length > 4) this.deleteFile(this.state.earlyFiles.shift().path)
        } else {
          this.deleteFile(path)
        }
        return
      }
      const now = this.state.queue.add(part, path)
      if (now) this.startPlayer(now) // else it waits for the clip before it to finish
    },

    // One player for the page, released (stop + release) the moment each clip finishes and reused
    // for the next one, like Zepp's Easy Media. A player still held when the app exits rebooted the
    // watch every time (2026-10-23: any clip, any format, even with no Bluetooth); released while
    // the app was open, it didn't. A second create() after a release returns nothing.
    startPlayer(path) {
      try {
        this.endPlayer()
        this.removeSpeechFile() // the previous clip's audio
        if (!this.state.player) this.state.player = create(id.PLAYER)
        const player = this.state.player
        if (!player) throw new Error("the watch's speaker is busy - close Hermes and open it again")
        if (!this.state.playerReady) {
          player.addEventListener(player.event.PREPARE, (ok) => {
            this.trace(`player prepare ${ok}`)
            this.report(`player prepare ${ok ? 'ok' : 'FAILED'} ${this.state.speechFile}`)
            if (ok) return player.start()
            this.endPlayer()
            this.voiceProblem(`Voice: the watch couldn't play it (${this.state.speechFile}).`)
          })
          player.addEventListener(player.event.COMPLETE, () => {
            this.endPlayer()
            this.trace('player complete, released')
            this.report('player complete, released')
            const next = this.state.queue ? this.state.queue.done() : null
            if (next) this.startPlayer(next) // the rest of a long answer
          })
          this.state.playerReady = true
        }
        this.state.speechFile = path
        this.state.playing = true
        player.setSource(player.source.FILE, { file: path })
        player.prepare()
      } catch (e) {
        this.endPlayer()
        this.voiceProblem(`Voice: ${errText(e)} (${path})`)
      }
    },

    // Stop and release the speaker; the player object stays for the next clip.
    endPlayer() {
      const player = this.state.player
      if (!player || !this.state.playing) return
      this.state.playing = false
      try {
        player.stop()
      } catch (e) {}
      try {
        player.release()
      } catch (e) {}
    },

    // Stop talking and drop clips still on their way (TALK, New chat, Voice off, closing).
    stopVoice() {
      this.state.queue = null
      this.endPlayer()
    },

    removeSpeechFile() {
      const file = this.state.speechFile
      this.state.speechFile = null
      this.deleteFile(file)
    },

    // The phone reuses a few file names for voice files, so a stale copy here must not linger.
    deleteFile(file) {
      if (!file) return
      try {
        rmSync({ path: file.replace(/^data:\/\//, '') })
      } catch (e) {}
    },

    // Voice failures never hide the answer: a small line under it says what went wrong.
    voiceProblem(message) {
      const m = this.model
      if (!m || !['answer', 'confirm'].includes(m.screen)) return
      this.show({ ...m, voiceNote: message || 'Voice: something went wrong.' })
    },

    startPoll(m) {
      this.state.busy = true
      this.show(m)
      const started = Date.now()
      let inFlight = 0 // when the current poll was sent (0: none)
      let seq = 0
      let failures = 0
      this.state.poll = setInterval(() => {
        if (inFlight && Date.now() - inFlight < POLL_STUCK_MS) return
        if (inFlight) {
          seq++ // the stuck poll's late reply, if any, is ignored
          const next = pollStep(null, failures)
          if (next.done) {
            this.cancelPoll()
            return this.finish(null)
          }
          failures = next.failures
        }
        if (Date.now() - started > POLL_LIMIT_MS) {
          this.cancelPoll()
          return this.finish({ ok: false, error: 'Hermes took more than 10 minutes. The answer may still come to Telegram.' })
        }
        inFlight = Date.now()
        const mine = ++seq
        const step = (r) => {
          if (mine !== seq || !this.state.poll) return
          inFlight = 0
          const next = pollStep(r, failures)
          if (!next.done) return (failures = next.failures)
          this.cancelPoll()
          const done = next.reply
          this.finish(done && done.ok && !done.heard && m.heard ? { ...done, heard: m.heard.replace(/^You said: /, '') } : done)
        }
        this.phoneRequest({ method: 'result', params: { job: m.job, speak: this.state.voiceOn } }, { timeout: 20000 })
          .then(step)
          .catch(() => step(null)) // a dropped poll is retried on the next tick
      }, POLL_MS)
    },

    cancelPoll() {
      this.state.resumeToken++ // stops a reopen check (fetchLast) too
      if (this.state.poll) clearInterval(this.state.poll)
      this.state.poll = null
      this.state.busy = false
      this.show({ screen: 'idle' })
    },

    // phoneRequest, sent again (same request id) when an attempt gets no reply in attemptMs or the
    // phone says it couldn't reach the PC ({retry: true}); the only place lost replies are retried.
    resendRequest(req, opts, attemptMs, budgetMs = REQUEST_BUDGET_MS) {
      return resendUntil(() => this.phoneRequest(req, { ...opts, timeout: attemptMs }), { attemptMs, budgetMs })
    },

    // request() to the phone, retried for up to 30 s while iOS wakes the Zepp app ("shake timeout");
    // the waiting screen says "Waking the phone" meanwhile, with a line telling the user to open Zepp
    // (a closed Zepp app looks like this every time, and the label alone didn't say what to do).
    phoneRequest(req, opts) {
      const waitingScreen = () => this.model && SPIN[this.model.screen]
      const done = (r) => {
        this.state.waking = false
        if (waitingScreen() && this.model.note === OPEN_ZEPP) this.show({ ...this.model, note: this.state.noteBeforeWake || '' })
        return r
      }
      const onWait = () => {
        this.state.waking = true
        if (waitingScreen() && this.model.note !== OPEN_ZEPP) {
          this.state.noteBeforeWake = this.model.note
          this.show({ ...this.model, note: OPEN_ZEPP })
        }
      }
      return untilPhoneWakes(() => this.request(req, opts), { budgetMs: WAKE_MS, onWait })
        .then(done, (e) => Promise.reject(done(e)))
    },

    newChat() {
      if (this.state.busy) return
      this.stopVoice()
      this.state.speechId = null
      this.state.busy = true
      this.state.waitSince = Date.now()
      this.show({ screen: 'thinking', heard: 'New chat' })
      this.resendRequest({ method: 'newChat', params: { rid: newRid() } }, {}, ASK_ATTEMPT_MS)
        .catch((e) => ({ ok: false, error: phoneError(e) }))
        .then((r) => {
          if (!r || !r.ok) return this.finish(r)
          this.state.busy = false
          vibrate()
          this.show({ screen: 'idle', note: 'New chat started. Tap TALK and ask Hermes' })
        })
    },

    confirm(confirmId, yes, label, card) {
      if (this.state.busy) return
      this.state.busy = true
      this.keepAwake(WAIT_BRIGHT_MS)
      this.state.waitSince = Date.now()
      this.show({ screen: 'thinking', heard: label || (yes ? 'Yes' : 'No') })
      this.resendRequest({ method: 'confirm', params: { id: confirmId, yes, speak: this.state.voiceOn, rid: newRid() } }, {}, confirmAttemptMs(card))
        .then((r) => this.finish(r))
        .catch((e) => this.finish({ ok: false, error: phoneError(e) }))
    },
  }),
)
