// The "Thinking" / "Still working" animation: a ring of dots around the round screen with a
// bright head chasing around it and a fading tail. Plain JS, so it runs on the watch and in
// Node tests; page/index.js recolours the dots on a timer.

// n dots evenly on a circle, the first at 12 o'clock, going clockwise.
export function ringDots(n, cx, cy, r) {
  const dots = []
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n
    dots.push({ x: Math.round(cx + r * Math.sin(a)), y: Math.round(cy - r * Math.cos(a)) })
  }
  return dots
}

// Colour between a (t = 0) and b (t = 1), channel by channel.
export function blend(a, b, t) {
  let out = 0
  for (const shift of [16, 8, 0]) {
    const x = (a >> shift) & 0xff
    const y = (b >> shift) & 0xff
    out |= Math.round(x + (y - x) * t) << shift
  }
  return out
}

// Dot colours for one animation step: the head is dot (step % n); the `tail` dots behind it
// fade from head to dim; the rest are dim.
export function dotColors(step, n, head, dim, tail) {
  const h = step % n
  const colors = []
  for (let i = 0; i < n; i++) {
    const behind = (h - i + n) % n
    colors.push(behind < tail ? blend(dim, head, 1 - behind / tail) : dim)
  }
  return colors
}

export function elapsedText(ms) {
  const s = Math.floor(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function dotsText(step) {
  return '.'.repeat((step % 3) + 1)
}
