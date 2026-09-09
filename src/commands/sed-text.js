import { utf8, utf8Decoder } from '../util.js'
import { delimiter } from './sed-regex.js'

const CONTROLS = { a: 7, f: 12, n: 10, r: 13, t: 9, v: 11, '\n': 10 }
const BASES = { d: 10, o: 8, x: 16 }

export function readSedText(p, command) {
  while (/[ \t]/u.test(p.script[p.i] ?? '')) p.i++
  if (p.i === p.script.length) throw new Error("expected \\ after 'a', 'c' or 'i'")
  command.text = null
  p.textState.pending = { command, raw: '' }
  if (p.script[p.i] === '\\') {
    const first = p.script[++p.i]
    if (first === undefined) return
    p.i++
    if (first !== '\n') p.textState.pending.raw = first
  }
  resumeSedText(p)
}

export function resumeSedText(p) {
  const pending = p.textState.pending
  if (!pending) return
  let text = pending.raw
  while (p.i < p.script.length && p.script[p.i] !== '\n') {
    const c = p.script[p.i++]
    if (c === '\\') {
      if (p.i === p.script.length) { pending.raw = text + '\n'; return }
      text += c + p.script[p.i++]
    } else text += c
  }
  // a writes this text verbatim; i/c replace its last byte with the output
  // record delimiter. Text scripts always use LF, including under sed -z.
  pending.command.text = normalizeText(text + '\n')
  p.textState.pending = null
}

export function finishSedText(state) {
  if (!state?.pending) return
  // GNU's final EOF copies unfinished text without escape normalization;
  // a bare a\ / i\ / c\ retains NULL instead of an empty output line.
  state.pending.command.text = state.pending.raw || null
  state.pending = null
}

function normalizeText(text) {
  return utf8Decoder.decode(normalizeBytes(text))
}

function normalizeBytes(text) {
  const input = utf8.encode(text), out = []
  for (let i = 0; i < input.length; i++) {
    const byte = input[i]
    if (byte !== 92 || i + 1 === input.length) { out.push(byte); continue }
    const escape = String.fromCodePoint(input[++i])
    if (Object.hasOwn(CONTROLS, escape)) { out.push(CONTROLS[escape]); continue }
    if (Object.hasOwn(BASES, escape)) {
      const base = BASES[escape], limit = base === 16 ? 2 : 3
      let digits = 0, value = 0
      while (digits < limit && i + 1 < input.length) {
        const c = input[i + 1]
        const digit = c >= 48 && c <= 57 ? c - 48 : (c | 32) >= 97 && (c | 32) <= 102 ? (c | 32) - 87 : -1
        if (digit < 0 || digit >= base) break
        value = value * base + digit; digits++; i++
      }
      out.push(digits ? value & 255 : escape.codePointAt(0))
    } else if (escape === 'c') {
      if (++i === input.length) continue
      const c = input[i]
      if (c === 92 && input[++i] !== 92) throw new Error('recursive escaping after \\c not allowed')
      out.push((c >= 97 && c <= 122 ? c - 32 : c) ^ 64)
    } else out.push(escape.codePointAt(0))
  }
  return Uint8Array.from(out)
}

export function readTransliteration(p) {
  const sep = delimiter(p, "'y' command")
  const source = normalizeBytes(transliterationSet(p, sep))
  const target = normalizeBytes(transliterationSet(p, sep))
  const from = p.byteLocale ? source : [...utf8Decoder.decode(source)]
  const to = p.byteLocale ? target : [...utf8Decoder.decode(target)]
  if (from.length !== to.length) throw new Error("'y' command strings have different lengths")
  const translation = p.byteLocale ? Uint8Array.from({ length: 256 }, (_, i) => i) : new Map()
  for (let i = 0; i < from.length; i++) {
    // GNU's byte table overwrites duplicates; its multibyte search uses
    // the first matching pair instead.
    if (p.byteLocale) translation[from[i]] = to[i]
    else if (!translation.has(from[i])) translation.set(from[i], to[i])
  }
  return { translation, byteLocale: p.byteLocale }
}

function transliterationSet(p, sep) {
  let text = ''
  while (p.i < p.script.length) {
    const c = p.script[p.i++]
    if (c === '\n') break
    if (c === sep) return text
    if (c !== '\\') { text += c; continue }
    const next = p.script[p.i++]
    if (next === undefined) break
    text += next === sep || next === '\n' ? next : c + next
  }
  throw new Error("unterminated 'y' command")
}

export function transliterateLine(text, command) {
  if (command.byteLocale) return utf8Decoder.decode(utf8.encode(text).map((byte) => command.translation[byte]))
  let out = ''
  for (const c of text) out += command.translation.get(c) ?? c
  return out
}
