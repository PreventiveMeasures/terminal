// Tokenize a command line and split it into a sequence of pipeline
// steps with short-circuit gates (`&&` / `||`) between them. Each
// step is a list of stages connected by `|`; each stage carries
// its argv plus optional stdout/stderr suppression flags, OR
// (for a subshell stage) a nested `group` of inner steps.
//
// Recognized boundary tokens:
//   `|`       — pipe to the next stage in the current step
//   `;`       — sequential run; next step runs regardless of the
//               previous step's exit code (the unconditional sibling
//               of `&&` / `||`)
//   `&&`      — run next step only if current step exited 0
//   `||`      — run next step only if current step exited non-zero
//   `(` `)`   — subshell grouping. The contents parse as their own
//               step list and run with an isolated cwd (so `cd`
//               inside `()` doesn't leak out). The group itself
//               occupies one stage slot and can be piped, gated,
//               and redirected like any other stage.
//   `>` / `1>` — redirect stdout; only `/dev/null` is allowed as
//               the target (the virtual FS is read-only) and means
//               "discard"
//   `2>`      — redirect stderr; same `/dev/null`-only restriction
//   `2>&1`    — merge stderr into stdout (and the symmetric `1>&2`).
//               Applied before `/dev/null` sinks, so `>/dev/null 2>&1`
//               silences both streams.
//   `>>` / `1>>` / `2>>` — append form, rejected outright
//
// Boundary tokens are tagged by `kind`, not by string value, so a
// quoted `"|"` / `">"` / `"("` stays an ordinary word.

export function parseLine(line) {
  const raw = tokenize(line)
  for (const t of raw) {
    if (t.kind === 'amp') throw new Error('background processes (`&`) are not supported')
  }
  // Trailing `;` is a no-op in bash; tolerate it so `cmd1; cmd2;`
  // doesn't trip the empty-stage check below. We don't extend the
  // same forgiveness to trailing `&&` / `||` because those would
  // wait for continuation in bash — without a continuation prompt,
  // erroring is the better signal.
  while (raw.length > 0 && raw.at(-1).kind === 'semi') raw.pop()
  const { steps, consumed } = buildSteps(raw, 0, false)
  if (consumed !== raw.length) throw new Error('unexpected `)`')
  validateSteps(steps)
  return steps
}

// A "group stage" carries no argv — its content is the nested
// `steps`. Its argv is unreachable, but checking `.group` first lets
// the same validator handle both shapes.
function validateSteps(steps) {
  for (const step of steps) {
    if (step.stages.length === 0) throw new Error('empty pipeline stage')
    for (const s of step.stages) {
      if (s.group) validateSteps(s.group)
      else if (s.argv.length === 0) throw new Error('empty pipeline stage')
    }
  }
}

// Recursive: when `inGroup` is true we're parsing the inside of a
// `(...)` and stop at the matching `)`. The returned `consumed`
// index points one past the consumed `)` (or one past the last
// token at top level), letting the caller resume from there.
function buildSteps(raw, start, inGroup) {
  const steps = [{ gate: 'first', stages: [] }]
  let stage = { argv: [], quoted: new Set() }
  let i = start
  while (i < raw.length) {
    const t = raw[i]
    if (t.kind === 'paren_close') {
      if (!inGroup) throw new Error('unexpected `)`')
      return finishGroup(steps, stage, i + 1)
    }
    if (t.kind === 'paren_open') {
      // A subshell occupies a whole stage slot. Allowing tokens to
      // accumulate before it (`echo a (cmd)`) would create an argv
      // + group hybrid with no sensible semantics, so error early.
      if (stage.group || stage.argv.length > 0) throw new Error('unexpected `(`')
      const inner = buildSteps(raw, i + 1, true)
      stage = { group: inner.steps, quoted: new Set() }
      i = inner.consumed
      continue
    }
    if (t.kind === 'pipe' || t.kind === 'and' || t.kind === 'or' || t.kind === 'semi') {
      steps.at(-1).stages.push(stage)
      stage = { argv: [], quoted: new Set() }
      if (t.kind === 'and') steps.push({ gate: 'and', stages: [] })
      else if (t.kind === 'or') steps.push({ gate: 'or', stages: [] })
      else if (t.kind === 'semi') steps.push({ gate: 'seq', stages: [] })
      i++
      continue
    }
    if (t.kind === 'redir') { i = applyRedir(stage, raw, i) + 1; continue }
    // After a closing `)` the only legal continuations are a boundary
    // token (handled above) or a redirect target for the group itself
    // (also above). Stray words like `(echo a) hi` land here.
    if (stage.group) throw new Error('unexpected token after `)`')
    if (t.quoted) stage.quoted.add(stage.argv.length)
    stage.argv.push(t.value)
    i++
  }
  if (inGroup) throw new Error('unmatched `(`')
  steps.at(-1).stages.push(stage)
  return { steps, consumed: i }
}

// Close out a `(...)` group. Two cases need care:
//   - `()` — truly empty subshell, distinct error from the generic
//     "empty pipeline stage" so the user sees what they did wrong.
//   - `(echo a;)` — trailing `;` before `)`, mirroring the top-level
//     trailing-semi tolerance. The semi already pushed an empty new
//     step; drop it here.
function finishGroup(steps, stage, consumed) {
  const lastStep = steps.at(-1)
  const stageEmpty = !stage.group && stage.argv.length === 0
  if (stageEmpty && lastStep.stages.length === 0) {
    if (steps.length === 1) throw new Error('empty subshell `()`')
    steps.pop()
  } else {
    lastStep.stages.push(stage)
  }
  return { steps, consumed }
}

function applyRedir(stage, raw, i) {
  const op = raw[i]
  // Format the operator how the user would have typed it: bare `>`
  // / `>>` for stdout (fd=1 implied), `2>` / `2>>` for stderr.
  // Avoids confusing messages like "redirect `1>` requires a
  // target" when the user typed plain `>`.
  const prefix = op.fd === '1' ? '' : op.fd
  // Fd-to-fd duplication (`2>&1` / `1>&2`): no file target to read,
  // just set the merge flag. Same-fd forms (`1>&1` / `2>&2`) silently
  // no-op — they're legal in bash and just redundant.
  if (op.toFd) {
    if (op.fd === '2' && op.toFd === '1') stage.mergeStderrToStdout = true
    else if (op.fd === '1' && op.toFd === '2') stage.mergeStdoutToStderr = true
    return i
  }
  const target = raw[i + 1]
  const label = prefix + '>' + (op.append ? '>' : '')
  if (op.append) {
    throw new Error(`filesystem is read-only — \`${label}\` append is not supported; use \`|\` to pipe or \`${prefix}>/dev/null\` to discard`)
  }
  if (!target || target.kind !== 'word') {
    throw new Error(`redirect \`${label}\` requires a target`)
  }
  if (target.value !== '/dev/null') {
    throw new Error(`filesystem is read-only — use \`|\` to pipe between commands, or \`${label}/dev/null\` to discard`)
  }
  if (op.fd === '1') stage.stdoutToNull = true
  else stage.stderrToNull = true
  return i + 1
}

function tokenize(line) {
  const tokens = []
  let cur = ''
  let quote = null
  let inToken = false
  // Sticky for the duration of one word: any quoting anywhere in
  // the token marks the whole token as "quoted" so the glob
  // expander leaves it literal. `dir/"*.js"` and `'dir/*.js'`
  // both produce a single token with quoted=true.
  let quoted = false
  const flush = () => {
    if (inToken) tokens.push({ kind: 'word', value: cur, quoted })
    cur = ''
    inToken = false
    quoted = false
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
      else cur += c
      continue
    }
    if (c === "'" || c === '"') { quote = c; inToken = true; quoted = true; continue }
    // `1>` / `2>` (and `1>>` / `2>>`) only at a token boundary, so
    // `cat2>foo` keeps `cat2` as one word and only `>` is the redirect.
    // `2>&1` / `1>&2` is the fd-to-fd duplication form — encoded into
    // a single redir token so applyRedir doesn't try to read a file
    // target for it. The target fd must be followed by end-of-input
    // or a delimiter so `2>&1foo` (which the user wrote as one
    // token) doesn't silently split into a fd-dup plus a stray word.
    if (!inToken && (c === '1' || c === '2') && line[i + 1] === '>') {
      flush()
      if (line[i + 2] === '&') {
        const m = line[i + 3]
        const after = line[i + 4]
        if ((m === '1' || m === '2') && (after === undefined || /[\s|&>;]/u.test(after))) {
          tokens.push({ kind: 'redir', fd: c, toFd: m })
          i += 3
          continue
        }
        // `N>&` followed by anything else: bare (`N>&`), invalid fd
        // (`N>&3`), or non-boundary junk (`N>&1foo`). Surface a
        // redirect-target error up front instead of letting the
        // bare `&` fall through to the amp / background-process
        // branch — that error reads as "background processes are
        // not supported" and obscures the real syntax issue.
        throw new Error(`redirect \`${c}>&\` requires fd 1 or 2 followed by a token boundary`)
      }
      if (line[i + 2] === '>') { tokens.push({ kind: 'redir', fd: c, append: true }); i += 2 }
      else { tokens.push({ kind: 'redir', fd: c, append: false }); i += 1 }
      continue
    }
    if (c === '|') {
      flush()
      if (line[i + 1] === '|') { tokens.push({ kind: 'or' }); i++ }
      else tokens.push({ kind: 'pipe' })
      continue
    }
    if (c === '&') {
      flush()
      if (line[i + 1] === '&') { tokens.push({ kind: 'and' }); i++ }
      else tokens.push({ kind: 'amp' })
      continue
    }
    if (c === '>') {
      flush()
      if (line[i + 1] === '>') { tokens.push({ kind: 'redir', fd: '1', append: true }); i++ }
      else tokens.push({ kind: 'redir', fd: '1', append: false })
      continue
    }
    if (c === ';') { flush(); tokens.push({ kind: 'semi' }); continue }
    // `(` / `)` flush mid-word the same way `;` / `|` do, so
    // `(echo a)` and `( echo a )` produce identical token streams
    // and `echo a;(echo b)` doesn't need whitespace around `(`.
    if (c === '(') { flush(); tokens.push({ kind: 'paren_open' }); continue }
    if (c === ')') { flush(); tokens.push({ kind: 'paren_close' }); continue }
    if (/\s/u.test(c)) { flush(); continue }
    cur += c; inToken = true
  }
  if (quote) throw new Error(`unterminated ${quote === "'" ? 'single' : 'double'} quote`)
  flush()
  return tokens
}

// Split a stage's tokens into { flags, values, positional } against
// a strict schema. Each command declares the option names it
// understands; any other `-x` / `--xyz` token throws — silent
// acceptance would let typos like `head -X 5` look like they did
// nothing. `--` ends flag processing; subsequent tokens are
// positional. A bare `-` or a token like `-5` (digits) is also
// positional so callers can pass numbers prefixed with `-`.
//
// Schema fields (each accepts an iterable of names; defaults empty):
//   short      — boolean short flags (e.g. `i` for `-i`)
//   long       — boolean long flags (e.g. `verbose` for `--verbose`)
//   valueShort — short flags that consume the next token as value
//                (e.g. `n` for `head -n 5`); inline `-n5` also works
//   valueLong  — long flags that consume the next token as value
//                (e.g. `name` for `find --name foo`)
//   stopAtFirstPositional — when true, stop parsing flags as soon
//                as a non-flag positional appears; the rest of the
//                tokens are pushed as positional verbatim. Used by
//                xargs so flags meant for the inner command (e.g.
//                `xargs grep -n PATTERN`) aren't eaten by xargs.
//
// Bundled short flags split across chars (`-an` → `-a` + `-n`); a
// value-taking short inside a bundle takes the rest of the bundle
// as its value (`-n5`).

export function parseArgs(tokens, schema = {}) {
  const short = asSet(schema.short)
  const long = asSet(schema.long)
  const valueShort = asSet(schema.valueShort)
  const valueLong = asSet(schema.valueLong)
  const stopEarly = schema.stopAtFirstPositional ?? false
  const flags = new Set()
  const values = new Map()
  const positional = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // `--` ends flag processing here, not at the top of the function:
    // a value-taking option (`--name`, `-n`) that immediately precedes
    // `--` consumes it as the value via `takeNext`, so the terminator
    // check has to run AFTER any value-consumption opportunity. POSIX
    // getopt behavior — pre-splitting the token list breaks it.
    if (t === '--') { positional.push(...tokens.slice(i + 1)); break }
    // Pure-dash tokens (`-`, `---`, `----`, …) are positional, not
    // flags. Without this `echo "---"` would die with
    // `unknown option: --` because the `--` long-flag branch (or
    // the short-flag bundle below) would try to interpret it.
    if (/^-+$/u.test(t)) { positional.push(t); continue }
    if (t.startsWith('--') && t.length > 2) {
      const name = t.slice(2)
      if (valueLong.has(name)) values.set(name, takeNext(tokens, ++i, `--${name}`))
      else if (long.has(name)) flags.add(name)
      else throw new Error(`unknown option: --${name}`)
      continue
    }
    if (t.startsWith('-') && t.length > 1 && !/^-\d/u.test(t)) {
      i = consumeShorts(tokens, i, short, valueShort, flags, values)
      continue
    }
    if (stopEarly) { positional.push(...tokens.slice(i)); break }
    positional.push(t)
  }
  return { flags, values, positional }
}

function asSet(v) {
  if (v instanceof Set) return v
  return new Set(v ?? [])
}

function takeNext(tokens, i, label) {
  if (i >= tokens.length) throw new Error(`${label} requires a value`)
  return tokens[i]
}

function consumeShorts(tokens, i, short, valueShort, flags, values) {
  const chars = tokens[i].slice(1)
  for (let j = 0; j < chars.length; j++) {
    const c = chars[j]
    if (valueShort.has(c)) {
      // Inline value (`-n5`) wins over the next token.
      if (j + 1 < chars.length) { values.set(c, chars.slice(j + 1)); return i }
      values.set(c, takeNext(tokens, ++i, `-${c}`))
      return i
    }
    if (!short.has(c)) throw new Error(`unknown option: -${c}`)
    flags.add(c)
  }
  return i
}
