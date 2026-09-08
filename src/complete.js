// Completion suggests executable commands or paths without running them.

import { lookup } from './fs.js'

// Return complete replacement lines while preserving preceding commands.
// Offer stdin readers after a pipe and directories only for cd operands.
export function complete(line, ctx, reg) {
  const { index: segStart, pipe } = lastCommandBoundary(line)
  const segment = line.slice(segStart)
  const wordStart = lastWordStart(segment)
  const word = segment.slice(wordStart)
  // `do` starts a command position inside a for loop.
  const before = segment.slice(0, wordStart).trim().replace(/^do(?:\s+|$)/u, '')
  // Only operators and redirects may follow `done`.
  if (/^done(?:\s|$)/u.test(before)) return []
  const commandPosition = before === ''
  const command = commandPosition ? '' : reg.resolveCommand(before.split(/\s+/u)[0])
  const head = line.slice(0, segStart + wordStart)
  // Append a space after a bare pipe without inserting one into a typed word.
  const sep = pipe && word === '' && head.endsWith('|') ? ' ' : ''
  return completeWord(word, commandPosition, pipe, command, ctx, reg).map((w) => head + sep + w)
}

// Bin prefixes complete registered commands. Arbitrary paths do not become
// executables, and arguments after a pipe have no path completion.
function completeWord(word, commandPosition, pipe, command, ctx, reg) {
  if (!commandPosition) return pipe ? [] : completePath(word, ctx, command === 'cd')
  const names = pipe ? reg.pipeNames : reg.names
  for (const prefix of reg.binPrefixes) {
    if (word.startsWith(prefix)) {
      const suffix = word.slice(prefix.length)
      return names.filter((n) => n.startsWith(suffix)).map((n) => prefix + n)
    }
  }
  if (word.startsWith('/') || word.startsWith('./')) return []
  return names.filter((n) => n.startsWith(word))
}

// Completion scans partial input permissively; this is not the shell lexer.
function lastCommandBoundary(line) {
  let index = 0
  let pipe = false
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '|') {
      const or = line[i + 1] === '|'
      i += or ? 2 : 1
      index = i
      pipe = !or
    } else if (c === '&' && line[i + 1] === '&') {
      i += 2
      index = i
      pipe = false
    } else if (c === ';' || c === '\n' || c === '(') {
      i++
      index = i
      pipe = false
    } else {
      i++
    }
  }
  return { index, pipe }
}

// Start index of the trailing run of non-whitespace characters.
// `'cat foo '` → 8 (empty word after the space). `'cat foo'` → 4.
function lastWordStart(s) {
  for (let i = s.length - 1; i >= 0; i--) {
    if (/\s/u.test(s[i])) return i + 1
  }
  return 0
}

function completePath(word, ctx, dirsOnly = false) {
  const lastSlash = word.lastIndexOf('/')
  const dirPart = word.slice(0, lastSlash + 1)
  const partial = word.slice(lastSlash + 1)
  const absDir = lookup(ctx.cwd, dirPart || '.', ctx.fs).path
  if (!ctx.fs.isDir(absDir)) return []
  const { dirs, files } = ctx.fs.listDir(absDir)
  // A leading dot opts into hidden entries.
  const names = dirs.map((name) => name + '/')
  if (!dirsOnly) names.push(...files)
  return names.filter((name) => name.startsWith(partial) && (partial.startsWith('.') || !name.startsWith('.')))
    .map((name) => dirPart + name)
}
