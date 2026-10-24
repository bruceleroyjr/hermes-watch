/*
 * Watch GPS for questions: the page keeps GPS on while the app is open. Each question carries
 * the latest fix; if there is none yet (indoors, cold start), a fix from an earlier question is
 * sent while it is under MAX_AGE_MS old.
 * Plain JS so it runs on the watch and in Node.
 */

export const MAX_AGE_MS = 10 * 60 * 1000

// Zepp's getLatitude/getLongitude give decimal degrees, or a DMS object on some firmware.
export function toDecimal(v) {
  if (typeof v === 'number') return v
  if (!v || typeof v !== 'object') return NaN
  const dd = Number(v.degrees) + Number(v.minutes || 0) / 60 + Number(v.seconds || 0) / 3600
  return /^[SW]$/i.test(String(v.direction || '')) ? -dd : dd
}

// A usable fix {lat, lon, at}, or null (0,0 is what an empty sensor reads, not a real place).
export function makeFix(lat, lon, at) {
  const la = toDecimal(lat)
  const lo = toDecimal(lon)
  if (!isFinite(la) || !isFinite(lo) || Math.abs(la) > 90 || Math.abs(lo) > 180) return null
  if (la === 0 && lo === 0) return null
  return { lat: la, lon: lo, at }
}

// What goes in the question's header: {lat, lon, age_s} rounded to ~1 m, or null when the
// fix is missing or too old.
export function locationFor(fix, now, maxAgeMs = MAX_AGE_MS) {
  if (!fix || !(now - fix.at <= maxAgeMs) || fix.at > now + 60000) return null
  const round = (x) => Math.round(x * 1e5) / 1e5
  return { lat: round(fix.lat), lon: round(fix.lon), age_s: Math.max(0, Math.round((now - fix.at) / 1000)) }
}
