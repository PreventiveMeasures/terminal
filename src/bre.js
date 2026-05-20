// POSIX Basic Regular Expression → ECMAScript regex translation — the
// dialect grep matches with by default (and under -G). A self-contained
// transpiler with no dependency on the command layer, so it lives in
// its own module. `breToEs(pattern)` returns `{ source }` (an ES `/u`-
// ready pattern body) or `{ error }` (a message string; only for a bare
// trailing backslash, which GNU grep also rejects).

// Return the length (in chars, INCLUDING the leading backslash) of a
// valid ES regex escape at `pattern[i]`. The caller passes through
// `pattern.slice(i, i + len)` verbatim. Returns 0 when `\<next>`
// isn't a valid ES escape (the caller drops the backslash and emits
// `next` as a literal, matching POSIX BRE "identity escape").
// Returns -1 for a trailing `\` with no following char.
//
// Why lookahead matters: ES /u rejects `\x`, `\u`, `\p` etc. unless
// followed by their required suffix (`\xHH`, `\u{...}` / `\uHHHH`,
// `\p{...}`, `\k<...>`, `\cX`). POSIX BRE / ugrep treat bare `\x`
// as literal `x`. Without validation we'd silently fail to compile
// the BRE-literal form.
function escapeLength(pattern, i) {
  const next = pattern[i + 1]
  if (next === undefined) return -1
  // ES-syntactic chars (identity escape) and GNU BRE extensions
  // (`\b`/`\B` word boundary, `\d`/`\D`/`\s`/`\S`/`\w`/`\W` class
  // escapes). NOT included: `\0`, `\t`, `\n`, `\r`, `\f`, `\v` —
  // strict POSIX BRE (and ugrep / GNU grep) treats those as literal
  // letters, not ES control escapes. `\0` in particular has the
  // legacy-octal ES /u footgun (`\01` etc. throws), which Copilot
  // flagged on PR #40.
  if ('^$\\.*+?()[]{}|/bBdDsSwW'.includes(next)) return 2
  if (next >= '1' && next <= '9') return 2  // backreference
  const isHex = (c) => c !== undefined && /[0-9A-Fa-f]/u.test(c)
  const balanced = (open, close) => {
    if (pattern[i + 2] !== open) return 0
    const end = pattern.indexOf(close, i + 3)
    return end > i + 3 ? end - i + 1 : 0
  }
  if (next === 'x') return isHex(pattern[i + 2]) && isHex(pattern[i + 3]) ? 4 : 0
  if (next === 'u') {
    // `\u{H..H}` requires 1-6 hex digits AND code point ≤ 0x10FFFF;
    // `\uHHHH` requires exactly 4 hex digits. Invalid forms fall
    // back to the BRE identity-escape branch (drop the backslash).
    if (pattern[i + 2] === '{') {
      const len = balanced('{', '}')
      const body = len ? pattern.slice(i + 3, i + len - 1) : ''
      const valid = body.length >= 1 && body.length <= 6 && [...body].every(isHex) && parseInt(body, 16) <= 0x10FFFF
      return valid ? len : 0
    }
    return [2, 3, 4, 5].every((k) => isHex(pattern[i + k])) ? 6 : 0
  }
  if (next === 'p' || next === 'P') return balanced('{', '}')
  if (next === 'c') return /[A-Za-z]/u.test(pattern[i + 2] ?? '') ? 3 : 0
  if (next === 'k') return balanced('<', '>')
  return 0
}

// Translate POSIX-style BRE to ES regex by swapping which form is
// the metachar: in BRE `(` `)` `{` `}` `+` `?` `|` are literal and
// `\(` `\)` etc. are the metachar; in ES it's the reverse. Inside
// `[...]` character classes nothing is swapped (POSIX and ES agree
// that those chars are literal there). Escape sequences other than
// the swapped set (`\d`, `\b`, `\s`, etc.) pass through unchanged
// — matching GNU grep's BRE-with-extensions rather than strict
// POSIX (where `\d` would be literal `d`).
//
// GNU BRE extensions also recognized:
//   `\<` / `\>` — start / end of word, both mapped to ES `\b`.
//     `\b` is symmetric (matches both transitions) where GNU's are
//     directional, but the common pattern `\<word\>` reads the same.
//   `*` at the very start of the pattern or immediately after `^`
//     is treated as literal (POSIX BRE rule: no preceding atom to
//     repeat). ES rejects these as "Nothing to repeat".
//   `^` and `$` are anchors only at the start / end of the pattern
//     (or adjacent to `\(`/`\|`/`\)`). Elsewhere they're literal —
//     POSIX BRE rule. ES treats both as anchors everywhere, which
//     would silently break searches for literal `$VAR` / `a^b`.
//
// Returns `{ source }` or `{ error }` — the latter only for a bare
// trailing `\`, which GNU grep also rejects as "Trailing backslash".
//
// Known divergences vs POSIX (ES semantics; reach for `-F` if needed):
// `\]` inside class is ES escape (POSIX: literal `\`); `[^]` matches
// anything (POSIX: error); `[[:alpha:]]`, `\(*\)` follow ES.
export function breToEs(pattern) {
  const SWAP = '(){}+?|'
  let out = ''
  let inClass = false
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (inClass) {
      // Inside `[...]`, escape handling mirrors the outside-class
      // branch but without SWAP / GNU-extension transforms: identity
      // escapes pass through if ES accepts them; otherwise drop the
      // backslash so `[\_]` / `[\a]` don't trip ES's invalid-escape
      // error on POSIX-style literal escapes.
      if (c === '\\') {
        const len = escapeLength(pattern, i)
        if (len === -1) return { error: 'trailing backslash (\\)' }
        if (len > 0) { out += pattern.slice(i, i + len); i += len - 1; continue }
        out += pattern[i + 1]; i++; continue
      }
      out += c
      if (c === ']') inClass = false
      continue
    }
    if (c === '[') {
      // POSIX: `]` immediately after `[` (or `[^`) is literal, not
      // class-close. ES /u rejects `[]…]` / `[^]…]`; escape the
      // leading `]` so the same chars land in the class.
      out += c; inClass = true
      // Skip past a leading `^` (negation) so the next iteration
      // doesn't reprocess it as a class member — `[^a]` was
      // being mis-emitted as `[^^a]`.
      if (pattern[i + 1] === '^') { out += '^'; i++ }
      // POSIX: `]` immediately after `[` (or `[^`) is literal. ES
      // /u rejects `[]…]` / `[^]…]`; escape it so the same chars
      // land in the class and the tracker doesn't exit early.
      if (pattern[i + 1] === ']') { out += '\\]'; i++ }
      continue
    }
    if (c === '\\') {
      if (i + 1 >= pattern.length) return { error: 'trailing backslash (\\)' }
      const next = pattern[i + 1]
      // BRE-specific transforms first — these aren't ES syntax,
      // so escapeLength would return 0 for them.
      if (SWAP.includes(next)) { out += next; i++; continue }
      if (next === '<' || next === '>') { out += '\\b'; i++; continue }
      // Validated ES escape (including multi-char `\xHH`, `\p{...}`).
      const len = escapeLength(pattern, i)
      if (len > 0) { out += pattern.slice(i, i + len); i += len - 1; continue }
      // POSIX BRE: backslash before non-special char is literal.
      out += next; i++; continue
    }
    // POSIX BRE: `*` at the start of the pattern (or right after
    // an anchor `^`) is literal because there's no preceding atom.
    // ES rejects both as "Nothing to repeat", which silently breaks
    // searches for literal `*` strings (e.g. `*ptr` in C source).
    // The `^` predecessor only counts when it's actually an anchor —
    // a literal mid-pattern `^` lets `*` repeat it normally
    // (`a^*b` means a + zero-or-more literal `^` + b).
    if (c === '*' && (i === 0 || (pattern[i - 1] === '^' && caretIsAnchor(pattern, i - 1)))) { out += '\\*'; continue }
    if (c === '^' && !caretIsAnchor(pattern, i)) { out += '\\^'; continue }
    if (c === '$' && !(i === pattern.length - 1 || (pattern[i + 1] === '\\' && (pattern[i + 2] === ')' || pattern[i + 2] === '|')))) { out += '\\$'; continue }
    if (SWAP.includes(c)) { out += '\\' + c; continue }
    out += c
  }
  return { source: out }
}

// POSIX BRE: `^` is an anchor at pos 0 or immediately after `\(` /
// `\|` (GNU group / alternation extension). Elsewhere it's literal.
function caretIsAnchor(pattern, i) {
  if (i === 0) return true
  return i >= 2 && pattern[i - 2] === '\\' && (pattern[i - 1] === '(' || pattern[i - 1] === '|')
}
