/*
 * Long recordings go to the phone in pieces. zml sends a request's Bluetooth chunks back to back
 * with no flow control; a 15 s clip (~40 KB, 12 chunks) gets through, a 45 s one (~120 KB) never
 * reached the phone. Each piece is its own request (same rid, part i of n); the phone keeps them
 * and sends the whole clip to the PC when the last one arrives.
 * Plain JS so it runs on the watch, the phone and in Node.
 */

export const PIECE_BYTES = 24 * 1024 // ~7 Bluetooth chunks

// ArrayBuffer -> [ArrayBuffer] of at most size bytes (one piece for a short clip).
export function splitAudio(buf, size = PIECE_BYTES) {
  const out = []
  for (let i = 0; i < buf.byteLength; i += size) out.push(buf.slice(i, Math.min(i + size, buf.byteLength)))
  return out.length ? out : [buf]
}

// Byte ranges of the pieces of a size-byte clip, so the watch can read one piece at a time from
// the file instead of holding the whole clip (a 90 s clip is ~245 KB) in memory twice.
export function pieceRanges(size, pieceBytes = PIECE_BYTES) {
  const out = []
  for (let start = 0; start < size; start += pieceBytes) out.push({ start, length: Math.min(pieceBytes, size - start) })
  return out
}

// Phone side: pieces by rid. put() returns the whole clip once every piece is in, else null.
// A resent piece just replaces itself; entries are dropped after keepMs.
export function pieceStore({ keepMs = 5 * 60 * 1000, now = Date.now } = {}) {
  const byRid = new Map()
  return {
    put(rid, part, parts, bytes) {
      for (const [k, v] of byRid) if (now() - v.at > keepMs) byRid.delete(k)
      let e = byRid.get(rid)
      if (!e || e.parts !== parts) byRid.set(rid, (e = { parts, pieces: new Array(parts), at: now() }))
      e.pieces[part - 1] = bytes
      e.at = now()
      for (let i = 0; i < parts; i++) if (!e.pieces[i]) return null
      let n = 0
      for (const p of e.pieces) n += p.length
      const all = new Uint8Array(n)
      let o = 0
      for (const p of e.pieces) {
        all.set(p, o)
        o += p.length
      }
      return all
    },
    missing(rid) {
      const e = byRid.get(rid)
      if (!e) return null
      const out = []
      for (let i = 0; i < e.parts; i++) if (!e.pieces[i]) out.push(i + 1)
      return out
    },
  }
}
