/*
 * Hermes on the watch: tap TALK, speak, tap STOP (stops by itself at 15 s). The recording
 * goes through the Zepp app on the phone to the PC (relay.js), which answers
 * with Hermes's reply, a Yes/No card for texts, emails and car commands, or a job id when
 * Hermes is slow (polled every 3 s for up to 10 min). Long answers scroll.
 * The watch closes the app when the screen times out; the current screen is saved and comes
 * back on reopen, and a reply that arrived meanwhile is fetched from the relay (/watch/last).
 */
import * as hmUI from '@zos/ui'
import { getDeviceInfo } from '@zos/device'
import { create, id, codec } from '@zos/media'
import { statSync, openSync, readSync, closeSync, rmSync, O_RDONLY } from '@zos/fs'
import { queryPermission, requestPermission } from '@zos/app'
import { scrollTo } from '@zos/page'
import { localStorage } from '@zos/storage'
import { setPageBrightTime, resetPageBrightTime, pauseDropWristScreenOff, resetDropWristScreenOff } from '@zos/display'
import { Vibrator } from '@zos/sensor'
import { BasePage } from '@zeppos/zml/base-page'
import { buildEnvelope } from '../shared/envelope'
import { untilPhoneWakes, phoneError } from '../shared/retry'
import { screenFor, pollStep, resumeFor, lastIsNew } from '../shared/screens'
import { ringDots, dotColors, elapsedText, dotsText } from '../shared/spinner'

const FILE = 'clip.opus'
const MAX_REC_MS = 15000
const POLL_MS = 3000
const WAKE_MS = 30000 // keep retrying while iOS wakes the Zepp app ("shake timeout")
const POLL_LIMIT_MS = 10 * 60 * 1000
const WAIT_BRIGHT_MS = 10 * 60 * 1000 // screen stays on while recording and waiting
const READ_BRIGHT_MS = 60 * 1000 // then a minute to read the answer
const MIC = 'device:os.mic'
const SAVED = 'last-screen'
const LAST_TRIES = 6 // x 3 s: the relay answers or hands out a job within 12 s
const GRANTED = 2

const { width: W, height: H } = getDeviceInfo()
const MARGIN = Math.round(W * 0.12)
const TEXT_W = W - 2 * MARGIN
const GREEN = 0x1e8449
const GREY = 0x5d6d7e
const BLUE = 0x2471a3

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

function readClip() {
  const st = statSync({ path: FILE })
  if (!st || !st.size) return null
  const fd = openSync({ path: FILE, flag: O_RDONLY })
  const buf = new ArrayBuffer(st.size)
  readSync({ fd, buffer: buf })
  closeSync(fd)
  return buf
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
    state: { widgets: [], recorder: null, recording: false, busy: false, startedAt: 0, timers: [], poll: null, renderTimer: null, anim: null, waitSince: 0, resumeToken: 0 },

    build() {
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
      this.stopAnim()
      this.clearTimers()
      try {
        if (this.state.recording) this.state.recorder.stop()
      } catch (e) {}
      resetPageBrightTime()
      resetDropWristScreenOff()
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
        this.button(y + 20, 'TALK', GREEN, talk)
      } else if (m.screen === 'listening') {
        y = this.text(Math.round(H * 0.3), `Listening... ${m.seconds || 0}s`, 34, 0x7fd4ff)
        this.button(y + 30, 'STOP', 0xc0392b, talk)
      } else if (m.screen === 'thinking' || m.screen === 'working') {
        this.renderWaiting(m)
      } else if (m.screen === 'confirm') {
        y = this.text(y + 20, m.heard, 24, 0x999999)
        y = this.text(y + 10, m.text, 32, 0xffffff)
        const bw = Math.round(W * 0.32)
        const gap = 16
        const left = Math.round((W - 2 * bw - gap) / 2)
        // Approve cards are Hermes asking for approval (Claude Code changes); Approve = this one time.
        const [yes, no] = m.approve ? ['Approve', 'Deny'] : ['Yes', 'No']
        this.button(y + 24, yes, GREEN, () => this.confirm(m.id, true, yes), bw, left)
        this.button(y + 24, no, GREY, () => this.confirm(m.id, false, no), bw, left + bw + gap)
        y += 24 + 80
        // Any other answer is spoken: it goes to Hermes as the next message and the card lapses.
        y = this.button(y + 16, 'Reply', BLUE, talk, 2 * bw + gap, left)
        this.add(hmUI.widget.TEXT, { x: 0, y: y + 60, w: W, h: 2, text: '' }) // scroll room
      } else {
        // answer / error
        y = this.text(y + 20, m.heard, 24, 0x999999)
        y = this.text(y + 10, m.text, 32, m.screen === 'error' ? 0xff7b6b : 0xffffff)
        y = this.button(y + 30, 'TALK', GREEN, talk)
        // TALK continues the conversation; New chat drops it (Hermes forgets the earlier turns).
        y = this.button(y + 16, 'New chat', GREY, () => this.newChat(), Math.round(W * 0.4))
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
      let audio
      try {
        audio = readClip()
      } catch (e) {
        return this.finish({ ok: false, error: `Could not read the recording: ${errText(e)}` })
      }
      if (!audio) return this.finish({ ok: false, error: 'Nothing was recorded. Try again.' })
      this.phoneRequest(buildEnvelope({ kind: 'ask' }, audio), { contentType: 'bin', dataType: 'json', timeout: 150000 })
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
    },

    startPoll(m) {
      this.state.busy = true
      this.show(m)
      const started = Date.now()
      let inFlight = false
      let failures = 0
      this.state.poll = setInterval(() => {
        if (inFlight) return
        if (Date.now() - started > POLL_LIMIT_MS) {
          this.cancelPoll()
          return this.finish({ ok: false, error: 'Hermes took more than 10 minutes. The answer may still come to Telegram.' })
        }
        inFlight = true
        const step = (r) => {
          inFlight = false
          const next = pollStep(r, failures)
          if (!next.done) return (failures = next.failures)
          this.cancelPoll()
          const done = next.reply
          this.finish(done && done.ok && !done.heard && m.heard ? { ...done, heard: m.heard.replace(/^You said: /, '') } : done)
        }
        this.phoneRequest({ method: 'result', params: { job: m.job } }, { timeout: 20000 })
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

    // request() to the phone, retried for up to 30 s while iOS wakes the Zepp app ("shake timeout");
    // the waiting screen says "Waking the phone" meanwhile.
    phoneRequest(req, opts) {
      const done = (r) => {
        this.state.waking = false
        return r
      }
      return untilPhoneWakes(() => this.request(req, opts), { budgetMs: WAKE_MS, onWait: () => (this.state.waking = true) })
        .then(done, (e) => Promise.reject(done(e)))
    },

    newChat() {
      if (this.state.busy) return
      this.state.busy = true
      this.state.waitSince = Date.now()
      this.show({ screen: 'thinking', heard: 'New chat' })
      this.phoneRequest({ method: 'newChat' }, { timeout: 150000 })
        .catch((e) => ({ ok: false, error: phoneError(e) }))
        .then((r) => {
          if (!r || !r.ok) return this.finish(r)
          this.state.busy = false
          vibrate()
          this.show({ screen: 'idle', note: 'New chat started. Tap TALK and ask Hermes' })
        })
    },

    confirm(confirmId, yes, label) {
      if (this.state.busy) return
      this.state.busy = true
      this.keepAwake(WAIT_BRIGHT_MS)
      this.state.waitSince = Date.now()
      this.show({ screen: 'thinking', heard: label || (yes ? 'Yes' : 'No') })
      this.phoneRequest({ method: 'confirm', params: { id: confirmId, yes } }, { timeout: 150000 })
        .then((r) => this.finish(r))
        .catch((e) => this.finish({ ok: false, error: phoneError(e) }))
    },
  }),
)
