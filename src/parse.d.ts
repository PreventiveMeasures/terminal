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
 * expansion it is waiting for, and says with `multi` whether what comes back
 * is still one word — except where its own kind already answers that: a brace
 * group is always more than one word, and a sum is never more than one. A
 * pattern and a brace are bare by definition — quoting either settles the text
 * instead.
 */
export type Part = string | PatternPart | BracePart | VariablePart | SubstitutionPart | ProcessPart | ArithmeticPart

/**
 * Bare text carrying glob syntax — `*`, `?`, or a `[` a bare `]` closes —
 * matched rather than read as text. Quoting settles the text instead, so a
 * pattern is never quoted: `a*` is one of these and `'a*'` is the string `a*`.
 *
 * Only where the shell matches: against the filesystem in a word list or a
 * redirect target, and against the other side in `[[ x == a* ]]`. An
 * assignment value, a here-string and every other `[[ … ]]` operand are
 * expanded and then left alone, so `x=*.js` is the string `*.js`, exactly as
 * bash assigns it.
 *
 * In a word of several pieces the pattern is the whole of it, with the other
 * pieces matching as the text they produce: `a*"b"` matches a name that starts
 * with `a` and ends with a literal `b`.
 *
 * `pattern` is the text where the line settles it, and the piece whose result
 * is that text where only running it does — `[[ a == $b ]]` matches by
 * whatever `b` holds, where `[[ a == "$b" ]]` compares that text and is a
 * {@link VariablePart} of its own. A piece stands here only on the pattern
 * side of `[[ x == y ]]`: it is the one slot that matches what it does not
 * split, and everywhere else matching travels with splitting, which
 * {@link VariablePart.multi} already answers.
 */
export interface PatternPart {
  type: 'pattern'
  pattern: string | VariablePart | SubstitutionPart
  /** Whether matching it may come back as more than one word: against the filesystem it may come back as any number of names, while the pattern side of `[[ x == a* ]]` is matched against the other side rather than expanded, and is the one operand it was written as. */
  multi: boolean
}

/**
 * A pattern the line settles the text of, which is every pattern but the one
 * `[[ x == $y ]]` matches by — so this is what stands wherever a piece cannot,
 * and reading its text needs no check that there is any.
 */
export interface StringPatternPart extends PatternPart {
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
 * of which the shell expands. A group that does expand is always more than one
 * word, so unlike a pattern it has nothing to say about how many come back.
 */
export interface BracePart {
  type: 'brace'
  source: string
}

/**
 * `$x`, `${x}`, `${x:-default}`, and the ones a shell keeps for itself: `$?`,
 * `$1`, `$@`.
 *
 * A `~` prefix is one of these: it names the home directory, which is what
 * `"$HOME"` names, and never more than one word for the same reason — tilde
 * expansion is neither split nor matched. `~/a` reads exactly as `"$HOME/a"`
 * does, and so
 * does the `~/a` in `PATH=~/a:~/b`, since a prefix opens a word or an
 * assignment component. Quoting one leaves the text alone: `a~b`, `~''/x` and
 * `~"/x"` are the paths they spell. A prefix naming a user or the directory
 * stack — `~alice`, `~+` — is refused rather than read, since bash expands it
 * and this shell has no users to look one up in.
 */
export interface VariablePart {
  type: 'variable'
  /** The name, or the character a special one is spelled with: `x`, `?`, `1`, `@`. */
  name: string
  /** What the reference does beyond reading the value — `:-`, `:=`, `:?`, `:+`, `#`, `##`, `%`, `%%`, `/`, `//`, `:` for a substring, and `length` for `${#x}`. Absent for a plain reference. */
  operator?: string
  /** The operator's operand, as written: the default in `${x:-a b}`, the pattern in `${x##prefix}`. Absent when the operator takes none. It is the source text rather than a {@link Value}, so an expansion inside it is text here too — `${x:-$(id)}` keeps `$(id)`, and {@link summarize} refuses it rather than say a line runs nothing it runs. */
  operand?: string
  /**
   * Whether what comes back may be more than one word, said either way: bare,
   * a result is split into fields and matched as a pattern, and quoting is
   * what settles it — as does a slot that splits nothing, an assignment
   * value, a here-string or a `[[ … ]]` operand. `"$@"` is the one quotes do
   * not settle: a word for each positional parameter, and none at all where a
   * shell has none, as this one does.
   */
  multi: boolean
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
  /** Whether the output may be more than one word, said either way: bare, it is split into fields and matched as a pattern, and quoting or a slot that splits nothing settles it. */
  multi: boolean
}

/**
 * `<( … )` or `>( … )`: commands again, so the commands are what it holds.
 * The word they become is a path — the one their output arrives on, or the
 * one they read what is written to — rather than the output itself, which is
 * what a {@link SubstitutionPart} becomes.
 *
 * `op` is the direction as written. There is no `multi`: a path is one word,
 * neither split into fields nor matched as a pattern. Quoting settles it as
 * text instead, so `"<(ls)"` is the string `<(ls)`, and nothing here opens a
 * command on a descriptor, so running one reports the gap rather than a path.
 */
export interface ProcessPart {
  type: 'process'
  op: '<' | '>'
  list: Node[]
}

/**
 * `$(( … ))`: the expression as written, which this parser does not read
 * further. A sum is a number and no number is two words — nothing splits on a
 * digit, since a custom `IFS` is refused, and no digit matches a file — so
 * unlike the other expansions this one says nothing about how many words come
 * back. It is always the one.
 *
 * A summary keeps it as it stands here, since an expression is not a list of
 * commands to summarize — unless it holds one, `$(( $(id -u) + 1 ))` being a
 * command behind text, which {@link summarize} refuses rather than hide.
 */
export interface ArithmeticPart {
  type: 'arithmetic'
  source: string
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

/**
 * `[[ x == y ]]`, `[[ a -lt b ]]`, `[[ f -nt g ]]`.
 *
 * Under `==`, `=` and `!=` the right side is a pattern and the left is the
 * text it matches: `*.js` there is a {@link PatternPart}, `"*.js"` is the
 * string it spells, and a bare `$b` is a {@link PatternPart} holding the
 * reference whose result is the pattern. Every other operand of every
 * operator is compared as the text it holds.
 */
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
   * `[[ … ]]` forms, a `~alice` home this shell cannot look up. Frozen and
   * deduplicated, in the shape a run reports.
   *
   * Only what parsing can see: whether a command exists, what an option means
   * and what an expansion produces are not settled here.
   */
  unsupported: readonly Unsupported[]
}

/**
 * One token of a chain that stands for a word: the text it will be, the
 * pattern it will be matched by, the variable it reads, the shell it waits
 * on, or the pieces those are joined from. Each says what it reaches for as
 * plainly as a name does —
 * `ls *.js` is `['ls', { type: 'pattern', pattern: '*.js', multi: true }]` and `ls ~/bin`
 * is `['ls', { type: 'parts', parts: [{ type: 'variable', name: 'HOME', multi: false }, '/bin'] }]`.
 *
 * A pattern here is a {@link StringPatternPart}: the one pattern whose text a
 * command has to run first stands on the pattern side of `[[ x == y ]]`, and
 * a `[[ … ]]` is not a chain to summarize.
 */
export type WordToken = TokenPiece | TokenParts

/** One piece of a {@link WordToken}, or the whole of one where it is the only piece. */
export type TokenPiece = string | StringPatternPart | VariablePart | ShellToken | ProcessToken | ArithmeticPart

/** One token of a chain: a word, or the assignments a command carries. */
export type Token = WordToken | AssignmentsToken

/**
 * A token in pieces: `a*"b"` is a pattern and the text behind it, and `~/bin`
 * is `$HOME` and the path behind that. Every piece is a token of its own, so
 * what the word reaches for stays as plain as the pieces are.
 */
export interface TokenParts {
  type: 'parts'
  parts: TokenPiece[]
}

/**
 * `$( … )` or `` ` … ` ``: the commands it runs, summarized as a line of their
 * own, and the word is whatever they print. A summary of commands is a
 * summary, so `` echo `a;b` `` holds one — which is what keeps
 * `` `a;b` ``, `` `a|b` `` and `` `a` `` three different words, quoted or not.
 *
 * `multi` is what quoting decides here as anywhere: bare, the output is split
 * into fields and matched as a pattern, so it may come back as any number of
 * words. A `"$(cat <<'EOF' … EOF)"` is not one of these at all — it is the
 * text that here-document holds, which nothing has to run to know.
 */
export interface ShellToken {
  type: 'shell'
  /** What it runs, summarized as a line of its own. */
  summary: Summary
  multi: boolean
}

/**
 * `<( … )` or `>( … )`: what it runs, summarized as a line of its own, and the
 * direction as written. The word is the path rather than the output, so unlike
 * a {@link ShellToken} it is one word however it was written.
 */
export interface ProcessToken {
  type: 'process'
  op: '<' | '>'
  summary: Summary
}

/**
 * The `A=1 B=2` a command carries, in one token at the head of its row —
 * where they were written, and where bash reads them. `A=1 B=2 cmd` sets them
 * for that command alone and `A=1 B=2` on its own sets them for the shell, so
 * a row may hold this and nothing else.
 *
 * A row's command name is its first token that is not this one.
 */
export interface AssignmentsToken {
  type: 'assignments'
  assignments: TokenAssignment[]
}

/** One `NAME=value` of an {@link AssignmentsToken}. Its value is never a pattern and never more than one word: an assignment value is expanded and then left alone. */
export interface TokenAssignment {
  name: string
  value: WordToken
}

/**
 * One command of a chain: each pipeline stage's `argv`, with the assignments
 * it carries in front, and each redirect as the tokens it was written with —
 * `['>', 'out']`, `['2>&1']`. Where a stage is a block, the row is the block.
 */
export type Chain = ChainRow[]

/** One row of a {@link Chain}: a command's tokens, or the block that stands where one would. */
export type ChainRow = Token[] | ChainParens | ChainBraces | ChainFor

/**
 * A `( … )` a chain runs: the commands inside, summarized as a line of their
 * own, since a subshell holds a list like any other — `(cd dir; ls) > out` is
 * `[{ type: 'parens', summary: [[['cd', 'dir']], [['ls']]] }, ['>', 'out']]`.
 *
 * Parentheses holding one command that changes nothing the shell around them
 * keeps are the command they hold: `(ls)` is `['ls']` and `(ls) | wc` is two
 * plain rows, while `(cd dir)` keeps them, since they are what stops the `cd`
 * reaching the shell. This is not the tree's `subshell`: a chain's rows are
 * commands, and what it holds is a {@link Summary} rather than a list of
 * nodes — which is why it is a `summary` here and a `list` there.
 */
export interface ChainParens {
  type: 'parens'
  /** What it runs, summarized as a line of its own. */
  summary: Summary
}

/**
 * A `{ …; }` a chain runs, which is a {@link ChainParens} but for the one
 * thing brackets decide: a brace group runs in the shell it stands in, so
 * a `cd`, an assignment or an `exit` inside it reaches the line around it.
 *
 * Which is why braces around a single command are dropped wherever
 * parentheses would only be dropped around a harmless one: `{ cd dir; }` is
 * `['cd', 'dir']`, while `(cd dir)` keeps its row.
 */
export interface ChainBraces {
  type: 'braces'
  /** What it runs, summarized as a line of its own. */
  summary: Summary
}

/**
 * A `for NAME in WORD…; do … done` a chain runs: the list it repeats,
 * summarized as a line of its own, and what it repeats that list over —
 * `for d in a-*; do echo "$d"; done` is one row holding the name `d`, the
 * pattern `a-*`, and a summary of the `echo`.
 *
 * `words` is empty for `for f in; do … done`, which runs nothing. As with
 * {@link ChainBraces}, this is not the tree's `for`: `summary` is a
 * {@link Summary} rather than a list of nodes, and the words are tokens.
 */
export interface ChainFor {
  type: 'for'
  /** The loop variable, which keeps its last value after the loop. */
  name: string
  /** The words after `in`, one turn of the loop each, with braces already expanded. */
  words: WordToken[]
  /** The loop body, summarized as a line of its own. */
  summary: Summary
}

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
 * text, and the substitution has to be one word, since bare its text would be
 * split into fields and globbed.
 *
 * A token is text, or the pattern or variable an argument is written as, the
 * shell whose output it will be, the word those are joined into, or the
 * `A=1 B=2` a command carries — each of which says what it reaches for as
 * plainly as a name says what it runs. Anything a summary
 * would have to lie about throws instead: a line that does not parse, an
 * `if` or `[[ … ]]`, a `!`, a
 * here-document whose delimiter leaves its body to expand, a stage that reads
 * its own input from inside a pipeline, and any word that would hide a
 * command inside text a summary keeps as written — `${x:-$(id)}`,
 * `$(( $(id -u) ))` — or the braces of an ambiguous redirect. {@link parse}
 * reads those; this is the short answer while a line stays simple, and an
 * error the moment it does not.
 *
 * @throws if the line does not parse, or holds anything but simple chains.
 */
export function summarize(line: string): Summary
