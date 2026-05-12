// Tokenize a command line and split it into a sequence of pipeline
// steps with short-circuit gates (`&&` / `||`) between them. Each
// step is a list of stages connected by `|`; each stage carries
// its argv plus optional stdout/stderr suppression flags.
//
// Recognized boundary tokens:
//   `|`       — pipe to the next stage in the current step
//   `&&`      — run next step only if current step exited 0
//   `||`      — run next step only if current step exited non-zero
//   `>` / `1>` — redirect stdout; only `/dev/null` is allowed as
//               the target (the virtual FS is read-only) and means
//               "discard"
//   `2>`      — redirect stderr; same `/dev/null`-only restriction
//   `>>` / `1>>` / `2>>` — append form, rejected outright
//
// Boundary tokens are tagged by `kind`, not by string value, so a
// quoted `"|"` / `">"` / `"&&"` stays an ordinary word.

export function parseLine(line) {
  const raw = tokenize(line)
  for (const t of raw) {
    if (t.kind === 'amp') throw new Error('background processes (`&`) are not supported')
  }
  const steps = buildSteps(raw)
  for (const step of steps) {
    if (step.stages.length === 0 || step.stages.some((s) => s.argv.length === 0)) {
      throw new Error('empty pipeline stage')
    }
  }
  return steps
}

function buildSteps(raw) {
  const steps = [{ gate: 'first', stages: [] }]
  let stage = { argv: [], quoted: new Set() }
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]
    if (t.kind === 'pipe' || t.kind === 'and' || t.kind === 'or') {
      steps.at(-1).stages.push(stage)
      stage = { argv: [], quoted: new Set() }
      if (t.kind === 'and') steps.push({ gate: 'and', stages: [] })
      else if (t.kind === 'or') steps.push({ gate: 'or', stages: [] })
      continue
    }
    if (t.kind === 'redir') { i = applyRedir(stage, raw, i); continue }
    if (t.quoted) stage.quoted.add(stage.argv.length)
    stage.argv.push(t.value)
  }
  steps.at(-1).stages.push(stage)
  return steps
}

function applyRedir(stage, raw, i) {
  const op = raw[i]
  const target = raw[i + 1]
  // Format the operator how the user would have typed it: bare `>`
  // / `>>` for stdout (fd=1 implied), `2>` / `2>>` for stderr.
  // Avoids confusing messages like "redirect `1>` requires a
  // target" when the user typed plain `>`.
  const prefix = op.fd === '1' ? '' : op.fd
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
    if (!inToken && (c === '1' || c === '2') && line[i + 1] === '>') {
      flush()
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
