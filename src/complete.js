// Completion suggests executable commands or paths without running them.

import { lookup } from './fs.js'
import { homeOf } from './shell/expand.js'
import { tokenize } from './shell/tokenize.js'

export function complete(line, ctx, reg) {
  const scanned = completionContext(line)
  if (!scanned) return []
  const { start, pipe, quote, words } = scanned
  while (OPENS_LIST.has(words[0])) words.shift()
  if (CLOSES_LIST.has(words[0])) return []
  // `for NAME in` takes a variable name and then the word `in`, neither of
  // which is a path or a command, and this shell has no names to offer.
  if (words[0] === 'for' && words.length <= 2) return []
  const raw = line.slice(start)
  const word = literalWord(raw, quote)
  if (!word) return []
  const commandPosition = words.length === 0
  const command = commandPosition ? '' : reg.resolveCommand(literalWord(words[0], null)?.value ?? '')
  const candidates = commandPosition ? completeCommand(word.value, pipe, reg, ctx.functions)
    : pipe ? [] : completePath(word, ctx, command === 'cd')
  const head = line.slice(0, start)
  // A bare pipe benefits from a space; a typed command must keep its prefix.
  const sep = pipe && raw === '' && head.endsWith('|') ? ' ' : ''
  return candidates.map((candidate) => head + sep + raw + quoteSuffix(candidate.slice(word.value.length), quote))
}

// The reserved words that stand in front of a list rather than end one: a word
// typed after any of them opens a command, so it completes as a command name.
// After a word that closes a block, bash takes no word at all.
const OPENS_LIST = new Set(['!', '{', 'do', 'then', 'else', 'elif', 'if', 'while', 'until'])
const CLOSES_LIST = new Set(['done', 'fi', '}', 'esac'])

// Bin prefixes complete registered commands, not arbitrary executable paths —
// and a function is not one of those, whatever it is named. Everywhere else a
// defined function is a command this shell runs, so it completes as one, after
// the registered names and only where it does not already stand among them.
function completeCommand(word, pipe, reg, functions) {
  const names = pipe ? reg.pipeNames : reg.names
  for (const prefix of reg.binPrefixes) {
    if (word.startsWith(prefix)) return names.filter((n) => n.startsWith(word.slice(prefix.length))).map((n) => prefix + n)
  }
  if (word.startsWith('/') || word.startsWith('./')) return []
  const defined = [...functions.keys()].filter((name) => !names.includes(name))
  return [...names, ...defined].filter((n) => n.startsWith(word))
}

// Read incomplete input while preserving original offsets. Quoted operators
// and blanks belong to filenames, including newlines inside quotes.
function completionContext(line) {
  let start = 0
  let pipe = false
  let quote = null
  let inWord = false
  let opened = -1
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
    // `name ()` opens a function body, the one place a `)` leads a command.
    if (c === '|' || and || c === ';' || c === '\n' || c === '(' || (c === ')' && opened === i - 1)) {
      if (or || and) i++
      if (c === '(') opened = i
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
  const { dirs, files, links } = ctx.fs.listDir(absDir)
  const names = dirs.map((name) => name + '/')
  // A link completes as what it leads to: one naming a directory takes the
  // slash that lets the next component follow it, and `cd` offers only those.
  for (const name of links) {
    if (ctx.fs.isDir(lookup(absDir, name, ctx.fs).path)) names.push(name + '/')
    else if (!dirsOnly) names.push(name)
  }
  if (!dirsOnly) names.push(...files)
  return names.filter((name) => name.startsWith(partial) && (partial.startsWith('.') || !name.startsWith('.')))
    // A bare dash filename would become an option (or stdin for commands like cat).
    .filter((name) => dirPart !== '' || partial === '' || !name.startsWith('-'))
    .map((name) => dirPart === '' && name.startsWith('-') ? './' + name : dirPart + name)
}
