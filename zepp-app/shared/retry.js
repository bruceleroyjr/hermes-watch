// Retrying requests whose reply got lost between the PC and the iPhone (iOS: "The network
// connection was lost"). The caller sends the same rid each time, so the PC answers a retry
// with the reply it already has. Plain JS, so it runs in the side service and in Node tests.

export function newRid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

// The watch's request() fails with "shake timeout" when Bluetooth is up but the Zepp app's side
// service on the iPhone didn't answer the 5 s handshake (iOS put Zepp to sleep). The request never
// reached the phone, so it is safe to try again while Zepp wakes up.
const ASLEEP = /shake timeout/i
const errText = (e) => (e && e.message ? e.message : String(e))

export async function untilPhoneWakes(attempt, { budgetMs, waitMs = 1000, onWait = () => {}, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const start = now()
  for (;;) {
    try {
      return await attempt()
    } catch (e) {
      if (!ASLEEP.test(errText(e)) || now() - start + waitMs >= budgetMs) throw e
      onWait()
      await sleep(waitMs)
    }
  }
}

export function phoneError(e) {
  if (ASLEEP.test(errText(e))) return "The phone isn't answering. Open the Zepp app on your iPhone, then try again."
  return `The phone didn't answer (${errText(e)}).`
}

// Watch side, the one place lost replies are retried: a request with no reply after attemptMs
// ("timeout"), or a {retry: true} reply from the phone (it couldn't reach the PC), is sent again -
// with the same request id, so the relay returns the reply it already has - until budgetMs.
// The phone can't do this itself reliably: iOS pauses the Zepp app's timers while it's locked.
// A sleeping phone ("shake timeout") is not resent: phoneRequest already waited 30 s for it.
export async function resendUntil(attempt, { attemptMs, budgetMs, waitMs = 1000, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const start = now()
  for (;;) {
    let r
    try {
      r = await attempt()
    } catch (e) {
      const t = errText(e)
      if (!/timeout/i.test(t) || ASLEEP.test(t) || now() - start + attemptMs >= budgetMs) throw e
      continue
    }
    if (!(r && r.ok === false && r.retry) || now() - start + attemptMs >= budgetMs) return r
    await sleep(waitMs)
  }
}

// iOS sometimes drops a reply without failing the request, and the phone then waited a minute or
// more before retrying. The relay always answers within its 12 s deadline, so a request with no
// reply after ms is lost: resolve with onTimeout(ms) (a {retry: true} failure) instead of waiting.
export function withTimeout(promise, ms, onTimeout) {
  let timer
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(onTimeout(ms)), ms) })
  return Promise.race([promise, late]).finally(() => clearTimeout(timer)) // also when it fails early
}

// Calls attempt() until it returns something other than a retryable failure ({retry: true}),
// at most `tries` times, and starts no new try once budgetMs has passed.
export async function withRetry(attempt, { tries, budgetMs, now = Date.now }) {
  const start = now()
  let r
  for (let i = 0; i < tries; i++) {
    r = await attempt()
    if (!(r && !r.ok && r.retry)) return r
    if (now() - start >= budgetMs) break
  }
  return r
}

// Extra wait for a recording's trip over Bluetooth to the phone: the request timer runs while it
// uploads (~9 KB/s measured; 4 KB/s allowed), so a 90 s clip (~245 KB) gets ~61 s more instead of
// being "lost" at 25 s and sent again whole.
export const UPLOAD_BYTES_PER_MS = 4
export function uploadAllowanceMs(bytes) {
  return Math.ceil((bytes || 0) / UPLOAD_BYTES_PER_MS)
}

// How long the watch waits for a reply before sending the request again (same rid; the relay
// returns the reply it kept). The relay answers within its 12 s deadline - an answer, a card or a
// job id - so ASK_ATTEMPT_MS after that the reply was lost on the iPhone (it was, 4 times on
// 2026-10-23, and the watch then waited 25 s). Yes/No on a Hermes card (ttlMs) or an Approve card
// goes through Hermes the same way; car commands and texts run on the PC and can take ~60 s.
export const ASK_ATTEMPT_MS = 17000
export const ACTION_ATTEMPT_MS = 70000
export function confirmAttemptMs(card) {
  return card && (card.ttlMs || card.approve) ? ASK_ATTEMPT_MS : ACTION_ATTEMPT_MS
}
