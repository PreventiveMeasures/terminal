// awk regexes are POSIX EREs; the JS engine is close but not identical,
// so every pattern — literal or dynamic — is translated before it is
// compiled. What changes:
//   `[[:alpha:]]` and friends   expanded to explicit ranges
//   `\y` `\<` `\>`              gawk word boundaries → `\b`
//   `\a`, octal `\ddd`, `\xHH`  awk escapes → ES escapes
//   `\/` `\"`                   the delimiter escapes → plain chars
//   `{`                         literal unless it forms an interval,
//                               and `{,n}` → `{0,n}`
//   stray `}` / `]`             literal (ES /u rejects them bare)
//   `\q` (any other escape)     the plain character, escaped
// The ES `u` flag is what makes the strictness bite (it rejects
// identity escapes like `\_`), and `s` makes `.` match a newline, as
// POSIX does — records read in paragraph mode contain them.
//
// Known divergences: `\b` is a word boundary (as in every other regex
// dialect a user is likely to know), not awk's backspace; `\d` `\s`
// `\w` keep their ES meaning rather than being the plain letter.

import { AwkError } from './awk-common.js'

const CLASSES = {
  __proto__: null,
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~',
  print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f',
  word: 'A-Za-z0-9_',
}

const SYNTAX = '^$\\.*+?()[]{}|'
const KEEP = new Set(['n', 't', 'r', 'f', 'v', 'b', 'B', 'd', 'D', 's', 'S', 'w', 'W'])
const hex2 = (n) => '\\x' + n.toString(16).padStart(2, '0')

// Translate the escape at `src[i]` (a backslash). Returns the ES text
// and the index of the last consumed character.
function escape(src, i, inClass) {
  const c = src[i + 1]
  if (c === undefined) throw new AwkError('trailing backslash in regex')
  if (SYNTAX.includes(c) || c === '/' || (inClass && (c === '-' || c === '^'))) return { text: '\\' + c, end: i + 1 }
  if (KEEP.has(c)) return { text: '\\' + c, end: i + 1 }
  if (!inClass && (c === 'y' || c === '<' || c === '>')) return { text: '\\b', end: i + 1 }
  if (c === 'a') return { text: hex2(7), end: i + 1 }
  if (c >= '0' && c <= '7') {
    let j = i + 1
    while (j < i + 4 && src[j] >= '0' && src[j] <= '7') j++
    return { text: '\\u{' + Number.parseInt(src.slice(i + 1, j), 8).toString(16) + '}', end: j - 1 }
  }
  if (c === 'x' && /[0-9a-fA-F]/u.test(src[i + 2] ?? '')) {
    let j = i + 2
    while (j < i + 4 && /[0-9a-fA-F]/u.test(src[j] ?? '')) j++
    return { text: hex2(Number.parseInt(src.slice(i + 2, j), 16)), end: j - 1 }
  }
  // `\"`, `\&`, `\q`, ...: the character itself. RegExp.escape yields a
  // spelling that is safe both inside and outside a bracket expression.
  return { text: RegExp.escape(c), end: i + 1 }
}

// A bracket expression, `src[i]` being the `[`. Returns the ES class
// and the index of the closing `]`.
function bracket(src, i) {
  let out = '['
  let j = i + 1
  if (src[j] === '^') { out += '^'; j++ }
  // A `]` right after the opener (or `[^`) is literal in POSIX.
  if (src[j] === ']') { out += '\\]'; j++ }
  while (j < src.length && src[j] !== ']') {
    const c = src[j]
    if (c === '[' && src[j + 1] === ':') {
      const close = src.indexOf(':]', j + 2)
      if (close !== -1) {
        const name = src.slice(j + 2, close)
        if (!(name in CLASSES)) throw new AwkError(`invalid character class \`[:${name}:]\``)
        out += CLASSES[name]; j = close + 2
        continue
      }
    }
    // Collating symbols / equivalence classes: `[.x.]` and `[=x=]` name
    // the character itself in the C locale.
    if (c === '[' && (src[j + 1] === '.' || src[j + 1] === '=')) {
      const close = src.indexOf(src[j + 1] + ']', j + 2)
      if (close !== -1) {
        out += RegExp.escape(src.slice(j + 2, close)); j = close + 2
        continue
      }
    }
    if (c === '\\') {
      const r = escape(src, j, true)
      out += r.text; j = r.end + 1
      continue
    }
    out += c === '[' ? '\\[' : c
    j++
  }
  if (j >= src.length) throw new AwkError('unterminated bracket expression in regex')
  return { text: out + ']', end: j }
}

const INTERVAL = /^\{(\d*)(,\d*)?\}/u

export function ereToEs(src) {
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') {
      const r = escape(src, i, false)
      out += r.text; i = r.end
    } else if (c === '[') {
      const r = bracket(src, i)
      out += r.text; i = r.end
    } else if (c === '{') {
      const m = INTERVAL.exec(src.slice(i))
      if (m && (m[1] !== '' || m[2] !== undefined)) {
        out += `{${m[1] === '' ? '0' : m[1]}${m[2] ?? ''}}`
        i += m[0].length - 1
      } else out += '\\{'
    } else if (c === '}' || c === ']') {
      out += '\\' + c
    } else out += c
  }
  return out
}

// Compiled patterns are cached by source text: a dynamic regex built
// from a string in the main loop would otherwise recompile per record.
const CACHE = new Map()

export function compileRegex(src) {
  const cached = CACHE.get(src)
  if (cached) return cached
  if (CACHE.size >= 500) CACHE.clear()
  let re
  try {
    re = new RegExp(ereToEs(src), 'su')
  } catch (e) {
    throw new AwkError(`invalid regex /${src}/: ${e.message}`)
  }
  CACHE.set(src, re)
  return re
}

// The same pattern with extra flags (`g` for gsub, `d` for match's
// capture positions), also cached.
export function withFlags(re, flags) {
  const key = `${flags} ${re.source}`
  let out = CACHE.get(key)
  if (!out) {
    out = new RegExp(re.source, re.flags + flags)
    CACHE.set(key, out)
  }
  return out
}
