// Whether the JavaScript matcher answers a pattern the way GNU does in the
// C.UTF-8 locale this terminal runs. Both read text a character at a time, so
// a literal, `.`, a bracket of ASCII members — negated or not — a repetition
// and a line anchor mean the same to each, over accented text as much as
// plain. What they read differently is what needs glibc's tables: `\w`, `\b`
// and the named classes past space and blank, and under `-i` and `-w` the
// folding and the word set. The guard below and the callers keep those out,
// and a pattern carrying a non-ASCII literal with them, so they stay refused
// over non-ASCII input rather than answered from the wrong tables.
import { parseEre } from './awk/re-parse.js'

const asciiSet = (n) => n.type === 'set' && n.items.every(([, hi]) => hi < 128)
const literal = (n) => n?.type === 'char' && n.code < 128

function compatible(n) {
  if (literal(n) || n.type === 'any' || asciiSet(n)) return true
  if (n.type === 'assert') return n.kind === '^' || n.kind === '$'
  if (n.type === 'group' || n.type === 'rep') return compatible(n.node)
  if (n.type === 'alt' || n.type === 'cat') return n.nodes.every(compatible)
  return false
}

export function asciiCompatible(source, original) {
  // Named classes retain locale dependence even after ASCII translation.
  const classes = [...original.matchAll(/\[:([a-z]+):\]/gu)].map((m) => m[1])
  if (classes.some((c) => c !== 'space' && c !== 'blank')) return false
  if (/[\u0080-\u{10FFFF}]|\\[1-9bBwW<>]/u.test(original)) return false
  try { return compatible(parseEre(source).ast) } catch { return false }
}

export function hasUnicodeSpace(text) {
  // NBSP is not space/blank in GNU's C or en_US.UTF-8 locale.
  return /[\u0085\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]/u.test(text)
}
