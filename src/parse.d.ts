import type { Unsupported } from './index.js'

export type { Unsupported, UnsupportedKind } from './index.js'

/** How a command joins the one before it. Absent on the first of a list. */
export type Operator = ';' | '&&' | '||'

/**
 * A word expansion has yet to settle: a `$` or backtick quoting has not
 * disarmed, or a bare `~`, glob or brace. Anything else is already its final
 * text and appears as a plain string, so `'*'` is `"*"` while `*.js` is one of
 * these.
 */
export interface Word {
  type: 'word'
  /** What was written, with quotes removed; an expansion keeps its own source, so `"$x"` reads as `${x}`. */
  value: string
  /**
   * Which characters of `value` were quoted, one per UTF-16 unit: `0` bare,
   * `1` hard-quoted, `2` inside double quotes, where substitutions still
   * happen. Absent when none of it was quoted. An expansion's source carries
   * `1` after its opening `$`, so a later pass reads it rather than expanding
   * it twice.
   */
  mask?: string
  /** Offsets where an empty quoted fragment (`""`, `''`) stood, which expansion must not lose: `$x""` keeps a final empty field. */
  empty?: number[]
}

/** Final text, or the word that still has to become it. */
export type Value = string | Word

/** `NAME=value`, in front of a command or on its own. */
export interface Assignment {
  name: string
  value: Value
}

/** `>` `>>` `&>` `&>>` `<`: a file, by a path that may still expand. The `&>` forms send stderr along with stdout. */
export interface FileRedirect {
  fd: number
  op: '>' | '>>' | '&>' | '&>>' | '<'
  target: Value
}

/** `2>&1`: make `fd` a copy of `toFd`. */
export interface DuplicateRedirect {
  fd: number
  op: '>&'
  toFd: number
}

/** `2>&-`: close `fd`. */
export interface CloseRedirect {
  fd: number
  op: '>&-'
}

/** `<<<`: the text goes to stdin, after expansion but without splitting. */
export interface HereString {
  fd: 0
  op: '<<<'
  text: Value
}

/** `<<`: the text collected from the lines after the command. `expand` is false for a quoted delimiter (`<<'EOF'`), whose text is literal. */
export interface HereDocument {
  fd: 0
  op: '<<'
  text: string
  expand: boolean
}

/** One redirect. They apply left to right, so `2>&1 >f` is not `>f 2>&1`. */
export type Redirect = FileRedirect | DuplicateRedirect | CloseRedirect | HereString | HereDocument

/** What every node may carry. */
export interface NodeBase {
  /** How this one joins the previous command; absent on the first, and on a pipeline's stages, which `|` already joins. */
  op?: Operator
  /** `!`: the status is inverted. Absent otherwise. */
  negate?: true
  /** Redirects, in source order. Absent when there are none. */
  redirects?: Redirect[]
  /** What bash warns about before running the command, such as a here-document the input ended before its delimiter. Absent when there is nothing to warn about. */
  warnings?: string
}

/**
 * A simple command: the name and its arguments, unexpanded. `argv` is empty
 * for a command that is only assignments or redirects, and for the empty
 * negated command a bare `!` writes.
 */
export interface Command extends NodeBase {
  type: 'command'
  argv: Value[]
  /** `NAME=value` prefixes. Without `argv` they assign; with it they are the command's own. Absent when there are none. */
  assignments?: Assignment[]
}

/** `a | b`: two or more stages. A pipeline of one is that command, not this. */
export interface Pipeline extends NodeBase {
  type: 'pipeline'
  /** Stages left to right; the last one's status is the pipeline's. */
  stages: Node[]
}

/** `( … )`: a list with its own working directory and variables. */
export interface Subshell extends NodeBase {
  type: 'subshell'
  list: Node[]
}

/** `{ …; }`: a list sharing the enclosing shell's directory and variables. */
export interface Group extends NodeBase {
  type: 'group'
  list: Node[]
}

/** `for NAME in WORD...; do LIST; done`. */
export interface ForLoop extends NodeBase {
  type: 'for'
  /** The loop variable, which keeps its last value after the loop. */
  name: string
  /** The words after `in`; empty for `for f in; do …; done`. */
  words: Value[]
  /** The loop body. */
  list: Node[]
}

/** One `if`/`elif` arm: the list whose status decides, and the list it guards. */
export interface Branch {
  condition: Node[]
  list: Node[]
}

/** `if … then … elif … else … fi`. */
export interface If extends NodeBase {
  type: 'if'
  /** The `if` arm first, then each `elif`, in order. */
  branches: Branch[]
  /** The `else` list. Absent when there is none. */
  otherwise?: Node[]
}

/** `[[ … ]]`, which runs no command. */
export interface Test extends NodeBase {
  type: 'test'
  expression: Condition
}

/** One command in a list. */
export type Node = Command | Pipeline | Subshell | Group | ForLoop | If | Test

/** `[[ a && b ]]`, `[[ a || b ]]`. */
export interface ConditionJunction {
  type: 'and' | 'or'
  left: Condition
  right: Condition
}

/** `[[ ! a ]]`. */
export interface ConditionNot {
  type: 'not'
  expression: Condition
}

/** `[[ -f x ]]`, and a bare `[[ x ]]`, which is `-n`. */
export interface ConditionUnary {
  type: 'unary'
  /** `-f`, `-z`, `-n`, … */
  op: string
  word: Value
}

/** `[[ x == y ]]`, `[[ a -lt b ]]`, `[[ f -nt g ]]`. */
export interface ConditionBinary {
  type: 'binary'
  op: string
  left: Value
  right: Value
}

/** A `[[ … ]]` expression. `=~` is refused rather than parsed. */
export type Condition = ConditionJunction | ConditionNot | ConditionUnary | ConditionBinary

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
   * The commands the line holds, in order, each carrying the `op` that joins
   * it to the one before. Newlines separate commands exactly as `;` does, so a
   * script is one list; a line that fails partway still carries the commands
   * ahead of the error, which are the ones a terminal would have run.
   *
   * A fresh tree on every call, and the caller's to keep or change.
   */
  list: Node[]
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
 * that a write its filesystem would refuse is reported there as the gap
 * `run()` would report.
 */
export function parse(line: string): ParseResult
