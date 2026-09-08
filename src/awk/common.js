// Shared parser tables, interpreter errors, and resource limits.

// A line marks a compile error (exit 1); otherwise it is fatal (exit 2).
// `gap` names an unsupported feature for the diagnostic channel. Ordinary
// syntax and runtime errors leave it null.
export class AwkError extends Error {
  constructor(message, line = null, gap = null) {
    super(message)
    this.line = line
    this.gap = gap
  }
}

export const KEYWORDS = new Set([
  'BEGIN', 'END', 'BEGINFILE', 'ENDFILE', 'function', 'func', 'if', 'else',
  'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit',
  'return', 'delete', 'in', 'getline', 'print', 'printf',
  'switch', 'case', 'default',
])

export const BUILTIN_ARITY = {
  __proto__: null,
  length: [0, 1], substr: [2, 3], index: [2, 2], split: [2, 3], sub: [2, 3], gsub: [2, 3],
  gensub: [3, 4], match: [2, 3], sprintf: [1, Infinity], sin: [1, 1], cos: [1, 1],
  atan2: [2, 2], exp: [1, 1], log: [1, 1], sqrt: [1, 1], int: [1, 1], rand: [0, 0],
  srand: [0, 1], tolower: [1, 1], toupper: [1, 1], close: [1, 2], fflush: [0, 1], systime: [0, 0],
  strtonum: [1, 1], and: [2, Infinity], or: [2, Infinity], xor: [2, Infinity],
  lshift: [2, 2], rshift: [2, 2], compl: [1, 1], typeof: [1, 1], isarray: [1, 1],
}

export const UNSUPPORTED_BUILTINS = new Map([
  ['system', 'system() is not supported: this terminal runs no processes'],
  ['strftime', 'strftime() is not supported (gawk extension)'],
  ['mktime', 'mktime() is not supported (gawk extension)'],
  ['asort', 'asort() is not supported (gawk extension)'],
  ['asorti', 'asorti() is not supported (gawk extension)'],
  ['patsplit', 'patsplit() is not supported (gawk extension)'],
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

// Shared diagnostic for every process-spawning form.
export const NO_PROCESSES = 'this terminal runs no processes'

export function arithmetic(op, a, b) {
  switch (op) {
    case '+': return a + b
    case '-': return a - b
    case '*': return a * b
    case '/': return a / b
    case '%': return a % b
    default: return a ** b
  }
}
