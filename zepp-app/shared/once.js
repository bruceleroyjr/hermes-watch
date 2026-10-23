// Runs fn() once per key: later callers get the same promise. The side service uses it for spoken
// answers, which it starts itself as a reply passes through while the watch may also ask for them.
// A failed job ({ok: false} or a rejection) is forgotten at once, so the next caller tries again;
// a finished one is kept for keepMs. Plain JS, so it runs on the phone and in Node tests.

export function onceBy(jobs, key, fn, { keepMs = 120000 } = {}) {
  if (jobs.has(key)) return jobs.get(key)
  const job = Promise.resolve().then(fn)
  jobs.set(key, job)
  const drop = () => { if (jobs.get(key) === job) jobs.delete(key) }
  const forgetLater = () => {
    const t = setTimeout(drop, keepMs)
    if (t && t.unref) t.unref() // Node only: don't keep tests running for it
  }
  job.then((r) => (r && r.ok === false ? drop() : forgetLater()), drop)
  return job
}
