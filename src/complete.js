// Completion suggests executable commands or paths without running them.

import { lookup } from './fs.js'
import { homeOf } from './shell/expand.js'
import { tokenize } from './shell/tokenize.js'

export function complete(line, ctx, reg) {
  const scanned = completionContext(line)
  if (!scanned) return []
  const { start, pipe, quote, words } = scanned
  if (words[0] === 'do') words.shift()
  if (words[0] === 'done') return []
  const raw = line.slice(start)
  const word = literalWord(raw, quote)
  if (!word) return []
  const commandPosition = words.length === 0
  const command = commandPosition ? '' : reg.resolveCommand(literalWord(words[0], null)?.value ?? '')
  const candidates = commandPosition ? completeCommand(word.value, pipe, reg)
    : pipe ? [] : completePath(word, ctx, command === 'cd')
  const head = line.slice(0, start)
  // A bare pipe benefits from a space; a typed command must keep its prefix.
  const sep = pipe && raw === '' && head.endsWith('|') ? ' ' : ''
  return candidates.map((candidate) => head + sep + raw + quoteSuffix(candidate.slice(word.value.length), quote))
}

// Bin prefixes complete registered commands, not arbitrary executable paths.
function completeCommand(word, pipe, reg) {
  const names = pipe ? reg.pipeNames : reg.names
  for (const prefix of reg.binPrefixes) {
    if (word.startsWith(prefix)) return names.filter((n) => n.startsWith(word.slice(prefix.length))).map((n) => prefix + n)
  }
  if (word.startsWith('/') || word.startsWith('./')) return []
  return names.filter((n) => n.startsWith(word))
}

// Read incomplete input while preserving original offsets. Quoted operators
// and blanks belong to filenames, including newlines inside quotes.
function completionContext(line) {
  let start = 0
  let pipe = false
  let quote = null
  let inWord = false
  const words = []
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") { if (c === quote) quote = null; continue }
    if (c === '\\' && (!quote || '$`"\\\n'.includes(line[i + 1]))) {
      if (i + 1 === line.length) return null
      if (line[++i] !== '\n') inWord = true
      continue
    }
    // Completing inside a substitution needs a separate parser context.
    if (c === '`' || (c === '$' && line[i + 1] === '(')) return null
    if (quote) { if (c === quote) quote = null; continue }
    if (c === "'" || c === '"') { quote = c; inWord = true; continue }
    if (c === '#' && !inWord) {
      const end = line.indexOf('\n', i)
      if (end === -1) return null
      i = end - 1
      continue
    }
    if (c === ' ' || c === '\t') {
      if (inWord) words.push(line.slice(start, i))
      start = i + 1
      inWord = false
      continue
    }
    const or = c === '|' && line[i + 1] === '|'
    const and = c === '&' && line[i + 1] === '&'
    if (c === '|' || and || c === ';' || c === '\n' || c === '(') {
      if (or || and) i++
      start = i + 1
      pipe = c === '|' && !or
      words.length = 0
      inWord = false
      continue
    }
    inWord = true
  }
  return { start, pipe, quote, words }
}

function literalWord(raw, quote) {
  if (raw === '') return { value: '', mask: null }
  try {
    const tokens = tokenize(raw + (quote ?? ''))
    if (tokens.length !== 1 || tokens[0].kind !== 'word') return null
    const word = tokens[0]
    // Do not guess which files an expansion in the typed prefix would select.
    for (let i = 0; i < word.value.length; i++) {
      const mask = word.mask?.[i] ?? '0'
      if ((mask !== '1' && word.value[i] === '$') || (mask === '0' && '*?[{'.includes(word.value[i]))) return null
    }
    return word
  } catch { return null }
}

function quoteSuffix(suffix, quote) {
  if (quote === "'") return suffix.replaceAll("'", "'\\''") + "'"
  if (quote === '"') return suffix.replace(/[\\$`"]/gu, '\\$&') + '"'
  // Backslash-newline is a continuation, so a filename newline needs quotes.
  return suffix.replace(/[\s\\'"`$&|;()<>*?[\]{}!#~]/gu, (c) => c === '\n' ? "'\n'" : '\\' + c)
}

function completePath(word, ctx, dirsOnly = false) {
  const value = word.value
  const home = value.startsWith('~') && (word.mask?.[0] ?? '0') === '0'
    && !word.empty?.some((i) => i <= 1) && (value.length === 1 || (word.mask?.[1] ?? '0') === '0')
  if (home && value === '~') return ctx.fs.isDir(lookup(ctx.cwd, homeOf(ctx), ctx.fs).path) ? ['~/'] : []
  if (home && !value.startsWith('~/')) return []
  const lastSlash = value.lastIndexOf('/')
  const dirPart = value.slice(0, lastSlash + 1)
  const partial = value.slice(lastSlash + 1)
  const path = home ? homeOf(ctx) + dirPart.slice(1) : dirPart || '.'
  const absDir = lookup(ctx.cwd, path, ctx.fs).path
  if (!ctx.fs.isDir(absDir)) return []
  const { dirs, files } = ctx.fs.listDir(absDir)
  const names = dirs.map((name) => name + '/')
  if (!dirsOnly) names.push(...files)
  return names.filter((name) => name.startsWith(partial) && (partial.startsWith('.') || !name.startsWith('.')))
    // A bare dash filename would become an option (or stdin for commands like cat).
    .filter((name) => dirPart !== '' || partial === '' || !name.startsWith('-'))
    .map((name) => dirPart === '' && name.startsWith('-') ? './' + name : dirPart + name)
}
