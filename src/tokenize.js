// Tokenizer for the virtual shell: turns one command line into the
// flat token stream parse.js structures into steps. Split out of
// parse.js when `$name` references joined the boundary tokens and the
// file crossed the size lint.
//
// Token kinds:
//   word         — `{ value, quoted, parts? }`. `quoted` is sticky for
//                  the whole word: any quoting anywhere in it marks the
//                  token so the brace/glob expanders leave it literal
//                  (`dir/"*.js"` and `'dir/*.js'` both come out as one
//                  quoted token). `parts` is present only when the word
//                  carries a variable reference — see below.
//   pipe / and / or / semi / amp
//                — `|`, `&&`, `||`, `;` (an unquoted newline also
//                  becomes `semi`), `&`
//   paren_open / paren_close
//                — `(` / `)`
//   redir        — `{ fd, append }` for `>` / `>>` / `1>` / `2>` …, or
//                  `{ fd, toFd }` for the `2>&1` / `1>&2` fd-dup form
//
// Variable references. `$name` and `${name}` — outside single quotes,
// and not right after a backslash — are the shell's parameter-expansion
// spelling, which `for` loops bind and index.js substitutes at run
// time. The word's `value` stays exactly as typed; alongside it,
// `parts` is the word split into literal strings and `{ name, raw }`
// references, so a reference nothing binds is put back verbatim (there
// is no environment to look it up in: `$HOME` prints as `$HOME`).
// Anything else after a `$` — `$1`, `$?`, `$(`, a `${…}` that is not a
// plain name — is ordinary text. Backslashes are not processed here at
// all (glob.js reads `\*`, bre.js reads `\(`), so `\$f` stays those
// three characters, unexpanded.

// A newline after one of these boundary tokens contributes nothing:
// the separator already exists (`;`) or the operator still needs its
// right-hand operand, so the command continues on the next line
// (`|` / `&&` / `||`, and an open `(`). After any other token — a
// word, a `)`, or a redirect — an unquoted newline ends the command,
// exactly like `;`. A leading newline (no token yet) is likewise a
// no-op, so blank lines never produce an empty stage.
const NEWLINE_ABSORB = new Set(['semi', 'and', 'or', 'pipe', 'paren_open'])

// Shell variable names: `[A-Za-z_][A-Za-z0-9_]*`. The anchored form
// validates a whole string (the `${…}` contents here, `for`'s loop
// variable in parse.js); the sticky form scans in place from just past
// a `$`.
export const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/u
const NAME_AT = /[A-Za-z_][A-Za-z0-9_]*/uy

export function tokenize(line) {
  const tokens = []
  let cur = ''
  let quote = null
  let inToken = false
  // Sticky for the duration of one word: any quoting anywhere in
  // the token marks the whole token as "quoted" so the glob
  // expander leaves it literal. `dir/"*.js"` and `'dir/*.js'`
  // both produce a single token with quoted=true.
  let quoted = false
  // `parts` collects the word's literal/reference split once a
  // reference appears; `partStart` is where, in `cur`, the literal
  // text since the last reference begins.
  let parts = null
  let partStart = 0
  const flush = () => {
    if (inToken) {
      const token = { kind: 'word', value: cur, quoted }
      if (parts) {
        if (cur.length > partStart) parts.push(cur.slice(partStart))
        token.parts = parts
      }
      tokens.push(token)
    }
    cur = ''
    inToken = false
    quoted = false
    parts = null
    partStart = 0
  }
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote && c === quote) { quote = null; continue }
    // A reference is read the same way bare and inside double quotes;
    // only single quotes (and a preceding backslash) keep `$` literal.
    if (c === '$' && quote !== "'" && line[i - 1] !== '\\') {
      const ref = readRef(line, i)
      if (ref) {
        parts ??= []
        if (cur.length > partStart) parts.push(cur.slice(partStart))
        parts.push(ref)
        cur += ref.raw
        partStart = cur.length
        inToken = true
        i += ref.raw.length - 1
        continue
      }
    }
    if (quote) { cur += c; continue }
    if (c === "'" || c === '"') { quote = c; inToken = true; quoted = true; continue }
    // `1>` / `2>` (and `1>>` / `2>>`) only at a token boundary, so
    // `cat2>foo` keeps `cat2` as one word and only `>` is the redirect.
    const op = !inToken && (c === '1' || c === '2') && line[i + 1] === '>'
      ? fdRedirect(line, i)
      : operator(line, i)
    if (op) { flush(); tokens.push(op.token); i += op.skip; continue }
    // An unquoted line feed terminates the current command. Emit a
    // `semi` so it parses identically to `;` downstream — but only
    // where it actually separates two commands: `NEWLINE_ABSORB`
    // swallows breaks that are leading, doubled (blank lines), or
    // follow a `|` / `&&` / `||` / `(` continuation. Only `\n` is a
    // separator; a `\r` falls through to the whitespace branch below,
    // so a `\r\n` pair ends the word and then the `\n` separates — one
    // clean break for Windows pastes. (Bash keeps a lone `\r` literal;
    // treating it as whitespace is a pre-existing quirk left as-is, so
    // a stray `\r` never silently splits a command.)
    if (c === '\n') {
      flush()
      const prev = tokens.at(-1)
      if (prev && !NEWLINE_ABSORB.has(prev.kind)) tokens.push({ kind: 'semi' })
      continue
    }
    if (/\s/u.test(c)) { flush(); continue }
    cur += c; inToken = true
  }
  if (quote) throw new Error(`unterminated ${quote === "'" ? 'single' : 'double'} quote`)
  flush()
  return tokens
}

// The boundary token starting at `line[i]`, or null when the character
// is not one. Each returns the token plus how many characters past `i`
// it consumed. `(` / `)` are boundaries mid-word the same way `;` / `|`
// are, so `(echo a)` and `( echo a )` produce identical token streams
// and `echo a;(echo b)` doesn't need whitespace around `(`.
function operator(line, i) {
  const c = line[i]
  const doubled = line[i + 1] === c
  switch (c) {
    case '|': return { token: { kind: doubled ? 'or' : 'pipe' }, skip: doubled ? 1 : 0 }
    case '&': return { token: { kind: doubled ? 'and' : 'amp' }, skip: doubled ? 1 : 0 }
    case '>': return { token: { kind: 'redir', fd: '1', append: doubled }, skip: doubled ? 1 : 0 }
    case ';': return { token: { kind: 'semi' }, skip: 0 }
    case '(': return { token: { kind: 'paren_open' }, skip: 0 }
    case ')': return { token: { kind: 'paren_close' }, skip: 0 }
    default: return null
  }
}

// The `N>` family at `line[i]` (N is `1` or `2`, `line[i + 1]` is `>`):
// `N>`, `N>>`, or the fd-to-fd duplication `N>&M` — encoded into a
// single redir token so applyRedir doesn't try to read a file target
// for it. The target fd must be followed by end-of-input or a
// delimiter so `2>&1foo` (which the user wrote as one token) doesn't
// silently split into a fd-dup plus a stray word.
function fdRedirect(line, i) {
  const fd = line[i]
  if (line[i + 2] === '&') {
    const m = line[i + 3]
    const after = line[i + 4]
    if ((m === '1' || m === '2') && (after === undefined || /[\s|&>;()]/u.test(after))) {
      return { token: { kind: 'redir', fd, toFd: m }, skip: 3 }
    }
    // `N>&` followed by anything else: bare (`N>&`), invalid fd
    // (`N>&3`), or non-boundary junk (`N>&1foo`). Surface a
    // redirect-target error up front instead of letting the
    // bare `&` fall through to the amp / background-process
    // branch — that error reads as "background processes are
    // not supported" and obscures the real syntax issue.
    throw new Error(`redirect \`${fd}>&\` requires fd 1 or 2 followed by a token boundary`)
  }
  const append = line[i + 2] === '>'
  return { token: { kind: 'redir', fd, append }, skip: append ? 2 : 1 }
}

// The reference starting at the `$` at `line[i]`, or null when what
// follows is not one. `raw` is the source text the reference stands
// for, kept so an unbound name can be echoed back exactly as typed.
function readRef(line, i) {
  if (line[i + 1] === '{') {
    const close = line.indexOf('}', i + 2)
    if (close === -1) return null
    const name = line.slice(i + 2, close)
    return NAME_RE.test(name) ? { name, raw: line.slice(i, close + 1) } : null
  }
  NAME_AT.lastIndex = i + 1
  const m = NAME_AT.exec(line)
  return m ? { name: m[0], raw: '$' + m[0] } : null
}
