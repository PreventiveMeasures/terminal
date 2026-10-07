// Shared parser tables, interpreter errors, and resource limits.

// An error that ends the run. Raised while running it is fatal (exit 2).
// Raised while reading the program it is one gawk stops at there (./parse.js):
// a syntax error (kind 'syntax', exit 1) or a fatal one ('fatal', exit 2),
// each with the `text` gawk prints for it, or an abort ('abort', exit 1)
// whose message is already in the parse log. `gap` names an unsupported
// feature for the diagnostic channel; ordinary errors leave it null.
export class AwkError extends Error {
  constructor(message, line = null, gap = null, kind = null) {
    super(message)
    this.line = line
    this.gap = gap
    this.kind = kind
    this.text = null
  }
}

// What gawk prints while it reads a program, in the order it prints it:
// warnings, errors (`error:`) and plain messages, each placed at a line of
// a source. Some warnings gawk gives once per run, keyed by `once`, which
// the run's own warnings share. Anything but a warning makes the program
// one gawk will not run.
export function createParseLog(once = new Set()) {
  const entries = []
  const log = {
    errors: 0,
    add(kind, msg, line, src) {
      entries.push({ kind, msg, line, src })
      if (kind !== 'warning') log.errors++
    },
    warn(msg, key, line, src) {
      if (key) {
        if (once.has(key)) return
        once.add(key)
      }
      log.add('warning', msg, line, src)
    },
    render(sources) {
      const prefix = { warning: 'warning: ', error: 'error: ', msg: '' }
      return entries.map((e) => `awk: ${e.line > 0 ? `${sourceName(sources, e.src)}:${e.line}: ` : ''}${prefix[e.kind]}${e.msg}\n`).join('')
    },
  }
  return log
}

// gawk's name for a piece of program text: the -f file as named, or
// `cmd. line` for program text given as an operand.
export const sourceName = (sources, src) => sources[src]?.name ?? 'cmd. line'

// gawk's built-in variables: no function may take one's name, nor use one
// as a parameter.
export const SPECIAL_VARS = new Set([
  'ARGC', 'ARGIND', 'ARGV', 'BINMODE', 'CONVFMT', 'ENVIRON', 'ERRNO', 'FIELDWIDTHS', 'FILENAME', 'FNR',
  'FS', 'FPAT', 'IGNORECASE', 'LINT', 'PREC', 'NF', 'NR', 'OFMT', 'OFS', 'ORS', 'PROCINFO', 'RLENGTH',
  'ROUNDMODE', 'RS', 'RSTART', 'RT', 'SUBSEP', 'TEXTDOMAIN',
])

export const KEYWORDS = new Set([
  'BEGIN', 'END', 'BEGINFILE', 'ENDFILE', 'function', 'func', 'if', 'else',
  'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit',
  'return', 'delete', 'in', 'getline', 'print', 'printf',
  'switch', 'case', 'default',
])

// The argument counts gawk accepts while reading a call. sprintf and the
// bit functions take any number there and check at run time.
export const BUILTIN_ARITY = {
  __proto__: null,
  length: [0, 1], substr: [2, 3], index: [2, 2], split: [2, 4], sub: [2, 3], gsub: [2, 3],
  gensub: [3, 4], match: [2, 3], sprintf: [0, Infinity], sin: [1, 1], cos: [1, 1],
  atan2: [2, 2], exp: [1, 1], log: [1, 1], sqrt: [1, 1], int: [1, 1], rand: [0, 0],
  srand: [0, 1], tolower: [1, 1], toupper: [1, 1], close: [1, 2], fflush: [0, 1], systime: [0, 0],
  strtonum: [1, 1], and: [0, Infinity], or: [0, Infinity], xor: [0, Infinity],
  lshift: [2, 2], rshift: [2, 2], compl: [1, 1], typeof: [1, 2], isarray: [1, 1],
}

export const UNSUPPORTED_BUILTINS = new Map([
  ['system', 'system() is not supported: this terminal runs no processes'],
  ['strftime', 'strftime() is not supported (gawk extension)'],
  ['mktime', 'mktime() is not supported (gawk extension)'],
  ['asort', 'asort() is not supported (gawk extension)'],
  ['asorti', 'asorti() is not supported (gawk extension)'],
  ['patsplit', 'patsplit() is not supported (gawk extension)'],
  ['mkbool', 'mkbool() is not supported (gawk extension)'],
  ['bindtextdomain', 'bindtextdomain() is not supported (gawk extension)'],
  ['dcgettext', 'dcgettext() is not supported (gawk extension)'],
  ['dcngettext', 'dcngettext() is not supported (gawk extension)'],
])

// Unsupported builtins fail during parsing, even in dead branches.
export const BUILTINS = new Set([...Object.keys(BUILTIN_ARITY), ...UNSUPPORTED_BUILTINS.keys()])

// Bound synchronous execution, including loop iterations.
export const MAX_STEPS = 5_000_000

// User-function nesting cap. Each awk-level call costs several JS
// frames, so this stays well inside the engine's default stack.
export const MAX_CALL_DEPTH = 100

// Refuse format sizes that would allocate excessively large strings.
export const MAX_FIELD_WIDTH = 1_000_000

// What gawk's `@` begins — `@/regex/`, `@f()`, `@include` — this does not run.
export const AT_GAP = 'typed regexes, indirect calls and source directives are not supported'

// Shared diagnostic for every process-spawning form.
export const NO_PROCESSES = 'this terminal runs no processes'

export function arithmetic(op, a, b) {
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return a / b
    case '%': return a % b
    default: return power(a, b)
  }
}

// gawk's `^` (calc_exp()): an integer exponent by repeated squaring, which
// rounds differently from pow() — 1.1^100 is 13780.612339822364 in gawk —
// and any other by pow().
export function power(x, y) {
  if (!Number.isInteger(y) || Math.abs(y) >= 2 ** 63) return x ** y
  if (y === 0) return 1
  let n = Math.abs(y)
  let mult = 1
  let base = x
  while (n > 1) {
    if (n % 2 === 1) mult *= base
    base *= base
    n = Math.floor(n / 2)
  }
  return y > 0 ? mult * base : 1 / (mult * base)
}
