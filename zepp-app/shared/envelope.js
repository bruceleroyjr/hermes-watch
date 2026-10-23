/*
 * Watch -> phone message: [u32 LE header length][ASCII JSON header][audio bytes].
 * Plain JS (no Buffer/TextEncoder) so it runs on the watch, the phone and in Node.
 */

export function buildEnvelope(header, audio) {
  const json = JSON.stringify(header)
  const body = new Uint8Array(audio)
  const out = new Uint8Array(4 + json.length + body.length)
  const n = json.length
  out[0] = n & 0xff
  out[1] = (n >>> 8) & 0xff
  out[2] = (n >>> 16) & 0xff
  out[3] = (n >>> 24) & 0xff
  for (let i = 0; i < n; i++) out[4 + i] = json.charCodeAt(i) & 0x7f
  out.set(body, 4 + n)
  return out.buffer
}

export function parseEnvelope(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  const n = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)
  if (bytes.length < 4 || n <= 0 || 4 + n > bytes.length) throw new Error('bad envelope')
  let json = ''
  for (let i = 0; i < n; i++) json += String.fromCharCode(bytes[4 + i])
  return { header: JSON.parse(json), audio: bytes.subarray(4 + n) }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function base64(bytes) {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + B64[v & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const v = bytes[i] << 16
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + '=='
  } else if (rest === 2) {
    const v = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64[(v >> 18) & 63] + B64[(v >> 12) & 63] + B64[(v >> 6) & 63] + '='
  }
  return out
}
