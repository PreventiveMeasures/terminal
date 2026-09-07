// Preserve empty quoted fragments through brace expansion and assignment
// slicing. Their positions matter: $x"" keeps a final empty field even
// when x ends in a field separator.
export function sliceWord(w, start = 0, end = w.value.length) {
  return {
    value: w.value.slice(start, end),
    mask: w.mask === null ? null : w.mask.slice(start, end),
    ...(w.empty ? { empty: w.empty.filter((i) => i >= start && i <= end).map((i) => i - start) } : {}),
  }
}

export function concatWords(...words) {
  let value = ''
  let mask = ''
  const empty = []
  for (const w of words) {
    for (const i of w.empty ?? []) empty.push(value.length + i)
    value += w.value
    mask += w.mask ?? '0'.repeat(w.value.length)
  }
  return { value, mask: words.every((w) => w.mask === null) ? null : mask, ...(empty.length ? { empty } : {}) }
}
