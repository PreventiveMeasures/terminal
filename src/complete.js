// Tab-completion, split out from index.js (the execution engine +
// registry) because it's an independent concern with a different input
// contract: it runs on PARTIAL, possibly-unparseable input (mid-token,
// quote state in flight), so it carries its own light boundary scanner
// instead of reusing parse.js's tokenizer. createTerminal hands in a
// small registry view — { names, pipeNames, binPrefixes, resolveCommand }
// — so completion stays decoupled from the registry's internals.

import { resolve } from './fs.js'

// Returns full-line replacements (NOT just word replacements): each
// entry preserves everything in `line` before the trailing word
// verbatim, so callers can drop one in without tokenizing or splicing
// — `cat|gre` → `cat|grep`.
//
// The trailing word is the run of non-whitespace at the end of the
// current command segment (after the last `|` / `&&` / `||` / `;`).
// Priority order for what fills that slot:
//   1. Command position, bin-prefixed token (`/usr/bin/grep…`)
//      → command list, bin prefix preserved on the way out.
//   2. Command position, token starting with `/` or `./` → `[]`.
//      Paths look like commands at the head of a segment, but the
//      dispatcher only recognizes binPrefixes as command paths;
//      everything else would be "command not found", so we don't
//      surface them. `./script.js`, `/src/foo`, `a;./x`, `a; ./x`
//      — all suppressed.
//   3. Command position, anything else → command list.
//   4. Argument position → walk the virtual FS treating the trailing
//      word as a path. `cat src/f` is equivalent to `cat ./src/f`;
//      empty trailing word lists the whole cwd, like bash.
//
// After a `|`, completion is doubly restricted: the command-name
// list shrinks to pipeNames (only commands that consume stdin),
// AND argument-position path completion is suppressed — the piped
// stream is the real data source, so file arguments would mislead
// the user. `||` / `&&` / `;` don't trigger any of this since each
// starts a fresh pipeline with its own stdin.
//
// Quote-blind by design (in both the boundary scan and the tail
// word): `parse.js` handles quoting for execution, but completion
// runs on partial input where quote state is mid-flight. Separators
// or whitespace inside a quoted region currently leak through.
export function complete(line, ctx, reg) {
  const { index: segStart, pipe } = lastCommandBoundary(line)
  const segment = line.slice(segStart)
  const wordStart = lastWordStart(segment)
  const word = segment.slice(wordStart)
  const before = segment.slice(0, wordStart).trim()
  const commandPosition = before === ''
  // Resolve the leading token of the segment so per-command rules
  // can fire on bin-prefixed forms too (`/usr/bin/cd` ≡ `cd`).
  // Empty in command position — `command` is only consulted on the
  // arg-position branch where `before` is non-empty by definition.
  const command = commandPosition ? '' : reg.resolveCommand(before.split(/\s+/u)[0])
  // Everything up to (but not including) the trailing word is
  // preserved verbatim — that's what makes each variant a drop-in
  // replacement for the entire input line.
  const head = line.slice(0, segStart + wordStart)
  // After a single `|`, ensure a space sits between the pipe and
  // the completion: `cat|gre` → `cat| grep`, `cat |` → `cat | grep`.
  // `head.endsWith('|')` is exactly the "no whitespace was typed
  // after the `|`" case (otherwise the trailing word would have
  // started at a later index, and `head` would end in whitespace).
  // `||` / `&&` / `;` aren't touched — only single-pipe completion.
  const sep = pipe && head.endsWith('|') ? ' ' : ''
  return completeWord(word, commandPosition, pipe, command, ctx, reg).map((w) => head + sep + w)
}

// In command position, bin-prefix and `./` / `/` path completion
// have to be handled explicitly — bare names there resolve against
// the command list, not the FS. In argument position the rules
// usually collapse to a `completePath` walk so `cat src/f` works
// the same as `cat ./src/f`.
//
// After a `|`, path completion is suppressed entirely: the piped
// stream is the data source, so offering file arguments would
// mislead users (`cat 1 | grep PATTERN /etc/hosts` shadows the
// pipe input). Only the command-name completion at the head of
// the pipe segment survives.
//
// resolveCommand strips bin prefixes when dispatching, so the
// `/usr/bin/...` shortcut is meaningful for argv[0] only. Surfacing
// it in arg position would mislead the user into `cat /usr/bin/grep`
// against a path that doesn't exist in the virtual FS.
// In command position, bin-prefix completion is the only way a
// path-looking token gets surfaced — resolveCommand strips
// binPrefixes at dispatch time, so `/usr/bin/grep` actually runs.
// Everything else starting with `/` or `./` would dispatch to
// "command not found" (no PATH lookup, no FS-resolved execution),
// so we return `[]` rather than mislead the user. Bare names fall
// through to the command-list filter.
//
// In argument position the rules collapse to `completePath` so
// `cat src/f` works the same as `cat ./src/f` — unless we're after
// a `|`, where the piped stream is the data source and file
// arguments would be misleading. For `cd`, completion restricts
// to directories (files aren't valid `cd` targets).
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

// Index just past the last unquoted `|`, `||`, `&&`, or `;` in
// `line`, plus whether that last boundary was a single `|` (so the
// caller can restrict completion to pipe-target commands).
// Two-char lookahead for `||` / `&&` is why this is an index loop
// rather than a for-of.
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
    } else if (c === ';') {
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
  const absDir = resolve(ctx.cwd, dirPart)
  if (!ctx.fs.isDir(absDir)) return []
  const { dirs, files } = ctx.fs.listDir(absDir)
  // Bash convention: dotfiles surface only once the partial itself
  // starts with `.`. Otherwise typing `/` would dump every hidden
  // entry every time.
  const showDot = partial.startsWith('.')
  const out = []
  for (const name of dirs) {
    if (!showDot && name.startsWith('.')) continue
    if (name.startsWith(partial)) out.push(dirPart + name + '/')
  }
  // `cd` and similar dir-only commands skip the file pass — files
  // wouldn't be valid arguments and listing them would mislead.
  if (dirsOnly) return out
  for (const name of files) {
    if (!showDot && name.startsWith('.')) continue
    if (name.startsWith(partial)) out.push(dirPart + name)
  }
  return out
}
