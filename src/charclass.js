// C-locale POSIX character classes shared by regex, glob, and tr parsers.
// 'word' is a GNU extension for letters, digits, and underscore.
export const POSIX_CLASSES = {
  __proto__: null,
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: '0-9A-Za-z',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\v\\f\\r',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  cntrl: '\\x00-\\x1F\\x7F',
  print: '\\x20-\\x7E',
  graph: '\\x21-\\x7E',
  word: '0-9A-Za-z_',
}

// ERE matching consumes numeric ranges; derive them from the same class bodies.
export const POSIX_RANGES = { __proto__: null }
for (const [name, body] of Object.entries(POSIX_CLASSES)) {
  const re = new RegExp(`[${body}]`, 'u')
  const ranges = []
  for (let code = 0; code < 128; code++) {
    if (!re.test(String.fromCharCode(code))) continue
    const last = ranges.at(-1)
    if (last && last[1] === code - 1) last[1] = code
    else ranges.push([code, code])
  }
  POSIX_RANGES[name] = ranges
}

// Read [:name:] and return its regex body and ending offset.
// Glob parsing treats unknown classes as empty sets; other callers reject them.
export function readPosixClass(s, i, opts = {}) {
  const m = /^\[:([a-z]+):\]/u.exec(s.slice(i))
  if (!m) return null
  const body = POSIX_CLASSES[m[1]]
  if (body === undefined) {
    if (opts?.unknown !== 'empty') throw new Error(`invalid character class \`[:${m[1]}:]\``)
    return { body: '', end: i + m[0].length }
  }
  return { body, end: i + m[0].length }
}
