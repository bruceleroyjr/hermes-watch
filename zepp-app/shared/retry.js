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
