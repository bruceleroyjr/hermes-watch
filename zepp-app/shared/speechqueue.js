// Plays an answer's voice clips in order (the relay splits long answers into the first sentence
// and the rest, so the voice starts sooner). add() when a clip's file arrives, done() when the
// player finishes one; each returns the file to play now, or null. Plain JS for Node tests.

export function speechQueue(parts) {
  const files = {}
  let next = 1 // the clip that plays next
  let playing = false
  return {
    add(part, path) {
      if (!(part >= 1 && part <= parts) || files[part]) return null
      files[part] = path
      if (playing || part !== next) return null
      playing = true
      return path
    },
    done() {
      playing = false
      next += 1
      if (next > parts || !files[next]) return null
      playing = true
      return files[next]
    },
    finished() {
      return next > parts
    },
  }
}
