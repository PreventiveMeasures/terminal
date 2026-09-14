import type { Unsupported } from './index.js'

export type { Unsupported, UnsupportedKind } from './index.js'

/**
 * How a step joins the one before it: `first` opens the list, `seq` follows a
 * `;` or a newline, `and` a `&&`, `or` a `||`.
 */
export type Gate = 'first' | 'seq' | 'and' | 'or'

/**
 * A word before expansion: the text with its quotes removed, plus what the
 * quoting was.
 *
 * `mask` carries one character per UTF-16 unit of `value`: `0` bare, `1`
 * hard-quoted, `2` inside double quotes, where substitutions still happen. It
 * is `null` when every character is bare and nothing was quoted.
 *
 * An expansion keeps its own source inside `value`: a `$` or backtick whose
 * mask is not `1` opens one, and the rest of its source — `(…)`, `{…}`,
 * `((…))`, up to the closing backtick — follows it masked `1`, so a later pass
 * reads it as text rather than expanding it twice. `"$f"` is stored as
 * `${f}` when a quote follows it, so that quote removal cannot join the name
 * to what comes next.
 */
export interface Word {
  /** The text, with quotes and escapes removed. */
  value: string
  /** Per-character quoting of `value`, or `null` when all of it is bare. */
  mask: string | null
  /**
   * Offsets where an empty quoted fragment (`""`, `''`) stood. Absent when
   * there were none. They survive expansion: `$x""` keeps a final empty field.
   */
  empty?: number[]
}

/** `NAME=value`, in front of a command or alone. The value is unexpanded. */
export interface Assignment {
  name: string
  word: Word
}

/** `2>&1`: make `fd` a copy of `toFd`. */
export interface DuplicateRedirect {
  fd: number
  op: 'dup'
  toFd: number
}

/** `2>&-`: close `fd`. */
export interface CloseRedirect {
  fd: number
  op: 'close'
  toFd?: undefined
}

/**
 * `>` `>>` `&>` `&>>`: send `fd` to a file. Exactly one of `target` and `word`
 * is present — `target` when the text is already final, `word` when expansion
 * has to produce it (`>$out`, `>/dev/nu*`).
 */
export interface WriteRedirect {
  fd: number
  op: 'to'
  /** The path as typed, when no expansion can change it. */
  target?: string
  /** The unexpanded path, when one can. */
  word?: Word
  /** `&>`: stderr follows stdout to the same place. */
  both: boolean
  /** `>>`: append rather than truncate. */
  append: boolean
  /** The operator as written, for diagnostics: `>`, `2>>`, `&>`, … */
  label: string
}

/**
 * `<<` and `<<-`: the body collected from the lines after the command.
 * `expand` is false for a quoted delimiter (`<<'EOF'`), whose body is literal.
 */
export interface HereDocument {
  fd: 0
  op: 'text'
  body: string
  expand: boolean
}

/** `<file` and `<<<here-string`, whose operand expands when the stage runs. */
export interface InputRedirect {
  fd: 0
  op: 'read' | 'herestring'
  word: Word
}

/** One redirect. They apply left to right, so `2>&1 >f` is not `>f 2>&1`. */
export type Redirect = DuplicateRedirect | CloseRedirect | WriteRedirect | HereDocument | InputRedirect

/** An operand inside `[[ … ]]`, quoted like any other word. */
export interface ConditionWord extends Word {
  kind: 'word'
  /** Whether any part of it was quoted, which keeps it from being an operator. */
  quoted: boolean
}

/** `[[ a && b ]]`, `[[ a || b ]]`. */
export interface ConditionJunction {
  kind: 'and' | 'or'
  left: Condition
  right: Condition
}

/** `[[ ! a ]]`. */
export interface ConditionNot {
  kind: 'not'
  expression: Condition
}

/** `[[ -f x ]]`, and a bare `[[ x ]]`, which is `-n`. */
export interface ConditionUnary {
  kind: 'unary'
  /** `-f`, `-z`, `-n`, … */
  op: string
  word: ConditionWord
}

/** `[[ x == y ]]`, `[[ a -lt b ]]`, `[[ f -nt g ]]`. */
export interface ConditionBinary {
  kind: 'binary'
  op: string
  left: ConditionWord
  right: ConditionWord
}

/** A `[[ … ]]` expression. `=~` is refused rather than parsed. */
export type Condition = ConditionJunction | ConditionNot | ConditionUnary | ConditionBinary

/** `for NAME in WORD...; do LIST; done`. */
export interface Loop {
  /** The loop variable, which keeps its last value after the loop. */
  name: string
  /** The list after `in`, unexpanded; empty for `for f in; do …; done`. */
  words: Word[]
  body: Step[]
}

/** One `if`/`elif` arm: the list whose status decides, and what it guards. */
export interface Branch {
  condition: Step[]
  body: Step[]
}

/** `if … then … elif … else … fi`. */
export interface Conditional {
  /** The `if` arm first, then each `elif`, in order. */
  branches: Branch[]
  /** The `else` body, or `null` when there is none. */
  otherwise: Step[] | null
}

/**
 * One stage of a pipeline: either a simple command — `words` and its
 * `assigns` — or one nested construct, never both. `redirs` belongs to
 * whichever it is.
 */
export interface Stage {
  /** The command and its arguments, unexpanded. Empty for a nested construct, and for a stage that is only assignments or redirects. */
  words: Word[]
  /** `NAME=value` prefixes; without `words` they assign, with `words` they are the command's own. */
  assigns: Assignment[]
  /** Redirects in source order. */
  redirs: Redirect[]
  /** `( … )` or `{ …; }`: the list inside it. */
  group?: Step[]
  /** True for `( … )`, which gets its own cwd and variables; false for `{ …; }`, which shares them. */
  isolate?: boolean
  /** `for … in …; do …; done`. */
  loop?: Loop
  /** `if … fi`. */
  conditional?: Conditional
  /** `[[ … ]]`, which runs no command. */
  test?: Condition
}

/** One gated pipeline. */
export interface Step {
  /** How it joins the previous step. */
  gate: Gate
  /** Pipeline stages left to right; the last one's status is the pipeline's. */
  stages: Stage[]
  /** `!`: the status is inverted. */
  negate: boolean
  /** Whether a `!` was written at all — `! ! cmd` leaves `negate` false. */
  bang: boolean
  /** What bash warns about before running the unit, such as a here-document the input ended before its delimiter. Absent when there is nothing to warn about. */
  warnings?: string
}

/** What the parser made of a line. */
export interface ParseResult {
  /** Whether the whole line parses. */
  ok: boolean
  /**
   * Whether the line stops inside a construct more input could finish: an
   * unclosed `(` or `{`, an `if` or `for` still missing its `then`, `do`, `fi`
   * or `done`, or a trailing `&&`, `||` or `|`. This is what an interactive
   * caller reads a continuation line for. `ok` is `false` either way; an
   * unterminated quote or `$( … )` is a syntax error rather than incomplete
   * input, and a here-document body ends with the input.
   */
  incomplete: boolean
  /** The diagnostic that stopped the parse, or `null` when `ok`. */
  error: string | null
  /**
   * The parsed line: input units in order, each a list of gated steps. Bash
   * parses one unit and runs it before reading the next, so a line that fails
   * partway still carries the units ahead of the error — the ones a terminal
   * would have executed. A one-line command is one unit.
   *
   * This is the tree the terminal's own engine runs, so it is enough to
   * render the line, walk it, or execute it yourself. It is a fresh parse on
   * every call and belongs to the caller; nothing here is frozen or shared.
   */
  units: Step[][]
  /**
   * Gaps this implementation has, that parsing itself reached: refused shell
   * constructs (`while`, `case`, `((`, `&`), unsupported `${…}` operators and
   * `[[ … ]]` forms. Frozen and deduplicated, in the shape a run reports.
   *
   * Only what parsing can see: whether a command exists, what an option means
   * and what an expansion produces are not settled here.
   */
  unsupported: readonly Unsupported[]
}

/**
 * Parse one command line and run none of it.
 *
 * This entry point is the parser alone: it has no commands, no filesystem and
 * no variables, so it never reports that a command is missing and never
 * refuses a redirect — where a line may write is a property of a terminal, not
 * of the line. `createTerminal(…).parse(line)` answers the same way, except
 * that a write its filesystem would refuse is reported there as the gap `run()`
 * would report.
 */
export function parse(line: string): ParseResult
