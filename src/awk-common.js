// Shared pieces of the awk implementation: the error class the command
// surfaces, the keyword and builtin tables the lexer and parser share,
// and the resource caps that keep a runaway program from hanging the
// (synchronous, in-memory) terminal.

// Every error the interpreter raises on purpose. With a `line` it is a
// syntax error — a program that failed to parse, surfaced as `awk:
// syntax error at line N: ...` with exit 1, gawk's status for a
// program it could not compile. Without one it is a fatal runtime error
// (division by zero, unreadable input, output to a file, ...): exit 2,
// as gawk.
export class AwkError extends Error {
  constructor(message, line = null) {
    super(message)
    this.line = line
  }
}

export const KEYWORDS = new Set([
  'BEGIN', 'END', 'BEGINFILE', 'ENDFILE', 'function', 'func', 'if', 'else',
  'while', 'for', 'do', 'break', 'continue', 'next', 'nextfile', 'exit',
  'return', 'delete', 'in', 'getline', 'print', 'printf',
  'switch', 'case', 'default',
])

// Every builtin name the lexer recognizes. The parser then decides what
// each one may do: the ones missing from UNSUPPORTED_BUILTINS are
// implemented; the rest are rejected AT PARSE TIME with a message naming
// the function, so `system("rm -rf /")` in a branch that never runs
// still fails loudly instead of silently doing nothing.
export const BUILTINS = new Set([
  'length', 'substr', 'index', 'split', 'sub', 'gsub', 'gensub', 'match',
  'sprintf', 'sin', 'cos', 'atan2', 'exp', 'log', 'sqrt', 'int', 'rand',
  'srand', 'tolower', 'toupper', 'close', 'fflush', 'systime',
  'strtonum', 'and', 'or', 'xor', 'lshift', 'rshift', 'compl',
  'typeof', 'isarray',
  'system', 'strftime', 'mktime', 'asort', 'asorti', 'patsplit',
])

export const UNSUPPORTED_BUILTINS = new Map([
  ['system', 'system() is not supported: this terminal runs no processes'],
  ['strftime', 'strftime() is not supported (gawk extension)'],
  ['mktime', 'mktime() is not supported (gawk extension)'],
  ['asort', 'asort() is not supported (gawk extension)'],
  ['asorti', 'asorti() is not supported (gawk extension)'],
  ['patsplit', 'patsplit() is not supported (gawk extension)'],
])

// Statement executions (loop iterations included) before the interpreter
// gives up. Every other command here is bounded by its input; awk is a
// language and can loop forever, and the terminal is synchronous, so a
// runaway program has to be cut off somewhere. Five million statements
// dwarfs any realistic pipeline stage (a million-line input with a
// handful of statements per record) while a `while (1)` typo dies in
// well under a second.
export const MAX_STEPS = 5_000_000

// User-function nesting cap. Each awk-level call costs several JS
// frames, so this stays well inside the engine's default stack.
export const MAX_CALL_DEPTH = 1000

// printf widths and precisions above this are refused rather than
// allocated: `%1000000000d` would otherwise try to build a gigabyte
// string.
export const MAX_FIELD_WIDTH = 1_000_000

// The message every rejected process-spawning form shares, so the four
// spellings (`system()`, `cmd | getline`, `print | cmd`, `print |& cmd`)
// read as one rule.
export const NO_PROCESSES = 'this terminal runs no processes'
