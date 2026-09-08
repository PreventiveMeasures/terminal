// Prove a translated ASCII pattern insensitive to UTF-8 vs byte matching.
// Literal ASCII atoms cannot split an encoded character. Unbounded wildcard
// stars can span it without counting its width. A wildcard plus additionally
// needs literal ASCII delimiters, so two pluses cannot split one character.
import { parseEre } from './awk-re-parse.js'

const asciiSet = (n) => n.type === 'set' && n.items.every(([, hi]) => hi < 128)
const wildcard = (n) => n.type === 'any' || (asciiSet(n) && n.negate)
const literal = (n) => n?.type === 'char' && n.code < 128

function compatible(n) {
  if (literal(n)) return true
  if (asciiSet(n) && !n.negate) return true
  if (n.type === 'assert') return n.kind === '^' || n.kind === '$'
  if (n.type === 'group') return compatible(n.node)
  if (n.type === 'alt') return n.nodes.every(compatible)
  if (n.type === 'cat') {
    return n.nodes.every((child, i) => compatible(child) || (
      child.type === 'rep' && child.min === 1 && child.max === null && wildcard(child.node)
      && literal(n.nodes[i - 1]) && literal(n.nodes[i + 1])
    ))
  }
  if (n.type === 'rep') return compatible(n.node) || (n.min === 0 && n.max === null && wildcard(n.node))
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
