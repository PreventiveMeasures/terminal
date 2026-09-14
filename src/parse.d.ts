import type { Unsupported } from './index.js'

export type { Unsupported, UnsupportedKind } from './index.js'

/** How a command joins the one before it. Absent on the first of a list. */
export type Operator = ';' | '&&' | '||'

/**
 * A word in more than one piece: the text, patterns, references and
 * substitutions it is made of, joined in order. A word of one piece is that
 * piece, and text nothing can change is a plain string — so `a*` is a
 * {@link PatternPart}, `'a*'` is `"a*"`, and only `a*"b"` is one of these.
 */
export interface Parts {
  type: 'parts'
  parts: Part[]
}

/**
 * One piece of a word — or the whole word, when it is the only piece.
 *
 * A piece is a plain string once nothing can change it, quoted or not: `"a b"`
 * is `'a b'`, and so is `a" "b`, whose runs join. Every other piece names the
 * expansion it is waiting for; the ones whose result quoting still governs say
 * so either way, since inside quotes a result is neither split into fields nor
 * matched as a pattern. A pattern and a brace are bare by definition — quoting
 * either settles the text instead.
 */
export type Part = string | PatternPart | BracePart | VariablePart | SubstitutionPart | ArithmeticPart

/**
 * Bare text carrying glob syntax — `*`, `?`, or a `[` a bare `]` closes —
 * matched against the filesystem rather than read as text. Quoting settles the
 * text instead, so a pattern is never quoted: `a*` is one of these and `'a*'`
 * is the string `a*`.
 *
 * In a word of several pieces the pattern is the whole of it, with the other
 * pieces matching as the text they produce: `a*"b"` matches a name that starts
 * with `a` and ends with a literal `b`.
 */
export interface PatternPart {
  type: 'pattern'
  pattern: string
}

/**
 * Braces this reading did not expand. Brace expansion needs nothing but the
 * text, so a word list arrives expanded — `a{b,c}` is the two words `ab` and
 * `ac` — and this is left for the two places that cannot be: a slot that takes
 * a single word, where a redirect target like `> {a,b}` is the ambiguous
 * redirect running it reports, and a group with more products than reading a
 * line should make.
 *
 * Braces nothing expands are never this: `a{b}` is the string `a{b}`, and so
 * are the braces in an assignment, a here-string or a `[[ … ]]` operand, none
 * of which the shell expands.
 */
export interface BracePart {
  type: 'brace'
  source: string
}

/**
 * `$x`, `${x}`, `${x:-default}`, and the ones a shell keeps for itself: `$?`,
 * `$1`, `$@`. `quoted` marks a reference inside double quotes, whose result is
 * neither split into fields nor matched as a pattern.
 *
 * A `~` opening a word is one of these: it names the home directory, which is
 * what `"$HOME"` names, and quoted for the same reason — tilde expansion is
 * never split or matched either. `~/a` reads exactly as `"$HOME/a"` does, and
 * `a~b`, `~''/x` and `~user` are text, since a tilde expands only at the start
 * of a word, only unquoted, and here only as the home directory.
 */
export interface VariablePart {
  type: 'variable'
  /** The name, or the character a special one is spelled with: `x`, `?`, `1`, `@`. */
  name: string
  /** What the reference does beyond reading the value — `:-`, `:=`, `:?`, `:+`, `#`, `##`, `%`, `%%`, `/`, `//`, `:` for a substring, and `length` for `${#x}`. Absent for a plain reference. */
  operator?: string
  /** The operator's operand, as written: the default in `${x:-a b}`, the pattern in `${x##prefix}`. Absent when the operator takes none. */
  operand?: string
  /** Whether it stands inside quotes, said either way: it decides whether the result is split into fields and matched as a pattern. */
  quoted: boolean
}

/**
 * `$( … )` or `` ` … ` ``: commands, so the commands are what it holds.
 * ``foo `bar a b c` `` names `foo`, and `bar` inside its argument.
 *
 * Bash parses a backtick when it expands it rather than when it reads the
 * line, so a backtick body that does not parse carries its diagnostic here and
 * an empty `list`, leaving the line itself readable — which is what running it
 * does too. A `$( … )` body is parsed with the line, so a broken one fails the
 * whole parse and never reaches this.
 */
export interface SubstitutionPart {
  type: 'substitution'
  list: Node[]
  /** Why the body did not parse, when it did not. Absent otherwise. */
  error?: string
  /** Whether it stands inside quotes, said either way: it decides whether the output is split into fields and matched as a pattern. */
  quoted: boolean
}

/** `$(( … ))`: the expression as written, which this parser does not read further. */
export interface ArithmeticPart {
  type: 'arithmetic'
  source: string
  /** Whether it stands inside quotes, said either way. */
  quoted: boolean
}

/** One piece, or the pieces a word joins. */
export type Value = Part | Parts

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
  /**
   * `&`: this command runs in the background, and the shell goes straight on
   * to the next. `&` ends a whole `a && b` list rather than one command of
   * it, so on a command carrying an `op` of `&&` or `||` it is the chain
   * ending here that runs there. Absent otherwise.
   *
   * Nothing runs in the background in this terminal: `run()` reports the gap
   * instead, which is why reading a line says this and running one refuses.
   */
  background?: true
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
   * constructs (`while`, `case`, `((`), unsupported `${…}` operators and
   * `[[ … ]]` forms. Frozen and deduplicated, in the shape a run reports.
   *
   * Only what parsing can see: whether a command exists, what an option means
   * and what an expansion produces are not settled here.
   */
  unsupported: readonly Unsupported[]
}

/**
 * One token of a chain: the text it will be, the pattern it will be matched
 * by, the variable it reads, or the word those are joined into. Each says what
 * it reaches for as plainly as a name does — `ls *.js` is
 * `['ls', { type: 'pattern', pattern: '*.js' }]` and `ls ~/bin` is
 * `['ls', { type: 'parts', parts: [{ type: 'variable', name: 'HOME', quoted: true }, '/bin'] }]`.
 */
export type Token = string | PatternPart | VariablePart | TokenParts

/**
 * A token in pieces: `a*"b"` is a pattern and the text behind it, and `~/bin`
 * is `$HOME` and the path behind that. Every piece is a token of its own, so
 * what the word reaches for stays as plain as the pieces are.
 */
export interface TokenParts {
  type: 'parts'
  parts: Array<string | PatternPart | VariablePart>
}

/**
 * One command of a chain: each pipeline stage's `argv`, and each redirect as
 * the tokens it was written with — `['>', 'out']`, `['2>&1']`.
 */
export type Chain = Token[][]

/**
 * A summarized line: its chains in order, with `&&` or `||` standing between
 * the two it gates, and `&` standing after the chain it hands to the
 * background — which may be the last of the line, since `&` ends one. A `;`
 * decides nothing about what follows, so nothing stands between those.
 *
 * ```js
 * summarize('ls & ls &')   // [ [['ls']], '&', [['ls']], '&' ]
 * ```
 */
export type Summary = Array<Chain | '&&' | '||' | '&'>

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

/**
 * The same line at a glance, for a caller that only wants to know what it
 * runs: one {@link Chain} per command, in order, with `&&` and `||` between
 * the chains they gate and `&` after the chain it backgrounds.
 *
 * ```js
 * summarize('foo -bar | head -10; ls > file.txt')
 * // [ [['foo', '-bar'], ['head', '-10']], [['ls'], ['>', 'file.txt']] ]
 * summarize('foo -bar | head -10 && ls > file.txt')
 * // [ [['foo', '-bar'], ['head', '-10']], '&&', [['ls'], ['>', 'file.txt']] ]
 * ```
 *
 * It says what the line does rather than how it was spelled, so whatever feeds
 * a command is the command that feeds it — a file is the `cat` that reads it,
 * and text is the `echo` that writes it:
 *
 * ```js
 * summarize('wc < 1.txt || ls')   // [ [['cat', '1.txt'], ['wc']], '||', [['ls']] ]
 * summarize("cat > notes.md <<EOF\nhello\nEOF\n")
 * // [ [['echo', 'hello'], ['>', 'notes.md']] ]
 * ```
 *
 * A `cat` left with nothing to read but its own input hands it straight on, so
 * it is left out once something is feeding the chain — which is why writing a
 * here-document to a file is one `echo` and its redirect. Where `echo` would
 * say something else than the text does — a body ending without a newline, or
 * a first word it would read as an option — `printf` says it exactly.
 *
 * A quoted `$(cat <<'EOF' … EOF)` is the text it holds, so that is what it
 * says: the here-document, minus the trailing newlines `$( )` strips.
 * `echo "$(cat <<'EOF'` … `EOF` … `)"` summarizes as `[[['echo', '…']]]`.
 * The delimiter has to be quoted, since an expanding body is not settled
 * text, and the substitution has to be quoted, since bare its text would be
 * split into fields and globbed.
 *
 * A token is text, or the pattern or variable an argument is written as, or
 * the word those are joined into — each of which says what it reaches for as
 * plainly as a name says what it runs. Anything a summary
 * would have to lie about throws instead: a line that does not parse, a
 * subshell, group, `for`, `if` or `[[ … ]]`, a `!`, an assignment, a
 * here-document whose delimiter leaves its body to expand, a stage that reads
 * its own input from inside a pipeline, and any word a command has to run
 * before its text is known — `` `date` ``, `$(( … ))`, or the braces of an
 * ambiguous redirect. {@link parse}
 * reads those; this is the short answer while a line stays simple, and an
 * error the moment it does not.
 *
 * @throws if the line does not parse, or holds anything but simple chains.
 */
export function summarize(line: string): Summary
