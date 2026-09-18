import type { ParseResult, Summary } from './parse.js'

/** Virtual source tree: file paths within the configured mount (leading `/` optional) to file contents, as either a plain object or a `Map`. */
export type Sources = Record<string, string> | Map<string, string>

/** Read-only view of the virtual source tree, handed to a {@link CommandRun} handler. Paths may be relative to {@link CommandIo.cwd}. */
export interface CommandFs {
  /** Absolutize and normalize `path` against the current working directory. */
  resolve(path: string): string
  /** Whether `path` names a file in the source tree. */
  isFile(path: string): boolean
  /** Whether `path` names a directory (directories are derived from the file paths). */
  isDir(path: string): boolean
  /** Contents of `path`, or `undefined` if it is not a file. */
  readFile(path: string): string | undefined
  /** Immediate children of directory `path`, each list sorted (copies — mutating them cannot affect the tree). Throws `<path>: Not a directory` / `No such file or directory` otherwise. */
  listDir(path: string): { dirs: string[]; files: string[] }
  /** Every file path at or under `path`, absolute. Empty if `path` does not exist. */
  walkFiles(path: string): string[]
}

/** One operand: a named file, a directory, a missing path, or stdin (`name: null`). */
export interface CommandInput {
  /** The operand as it was typed, or `null` for stdin. */
  name: string | null
  /** File contents, or the piped stdin string. Empty for anything unreadable. */
  content: string
  /** Whether the operand read as a file, named a directory, or was not there at all. */
  kind: 'file' | 'dir' | 'missing'
}

/** Result of {@link CommandIo.readInputs}: the coreutils partial-failure model. */
export interface CommandInputs {
  /** Inputs that could be read, in operand order — the subset a filter wants. */
  inputs: CommandInput[]
  /** Every operand in order, readable or not, so a command can tell a directory from a missing path. */
  entries: CommandInput[]
  /** One `cmd: path: reason` line per unreadable operand. */
  stderr: string
  /** True if any operand failed; conventionally exit 1 while still emitting what did read. */
  failed: boolean
}

/** Everything a wired command is given. Read-only: a handler cannot change the terminal's cwd or the source tree. */
export interface CommandIo {
  /** The name this command was registered under. */
  name: string
  /** Operands after the command name, with brace expansion, `for`-loop variable substitution and glob expansion already applied. */
  args: string[]
  /** Stdin from the previous pipeline stage; `''` when the command starts a pipeline. */
  stdin: string
  /** Absolute working directory at the time of the call. */
  cwd: string
  /** Read-only view of the virtual source tree. */
  fs: CommandFs
  /** Read each path, collecting errors instead of aborting. Called with no arguments (or an empty list) it yields one nameless input carrying {@link CommandIo.stdin} — the shape a pure filter wants. */
  readInputs(paths?: readonly string[]): CommandInputs
}

/**
 * What a {@link CommandRun} handler may return in place of a plain string.
 * Missing fields default to `''` / `0`, but at least one must be present and
 * no other field may be — an object that is not a result (an array of lines
 * awaiting a `join`, a binary digest, a misspelled key) is rejected rather
 * than read as a successful command that printed nothing.
 */
export interface CommandResult {
  stdout?: string
  /** Gets a trailing newline if it lacks one, so consecutive error lines stay separate. */
  stderr?: string
  /** Non-negative integer; gates `&&` / `||` like any other command's status. */
  exitCode?: number
}

/**
 * A wired command's implementation. Returning a string is shorthand for that
 * stdout with exit 0, and returning nothing is a silent success. Must be
 * synchronous — the engine feeds one stage's stdout to the next with no await
 * point, so a returned promise is rejected rather than stringified into the
 * stream. Throwing is fine, and the thrown value need not be an `Error`: its
 * message (or the value itself) surfaces as a `name: reason` stderr line with
 * exit 1, exactly like a built-in command's internal error, leaving the rest
 * of the command line to run its gates normally.
 */
export type CommandRun = (io: CommandIo) => string | CommandResult | void

/**
 * A wired command with its registry metadata. A bare {@link CommandRun} is
 * shorthand for `{ run }`; `pipe` and `hidden` belong on this object, and
 * setting them on the handler function instead is rejected rather than
 * silently ignored.
 */
export interface CommandSpec {
  run: CommandRun
  /** Offer this command as a completion target after `|`. Set it when the handler reads `stdin`. Defaults to `false`. */
  pipe?: boolean
  /** Keep the command dispatchable (and resolvable by `which`) but out of completion and the "Available: …" hint. Defaults to `false`. */
  hidden?: boolean
}

/**
 * Commands to wire in, keyed by the name they are typed as: a plain object
 * (own enumerable properties) or a `Map`. Anything else — an array, a `Set`,
 * a class instance whose handlers live on the prototype — is rejected, since
 * it would otherwise register nothing, or register index keys as names.
 */
export type Commands =
  | Record<string, CommandRun | CommandSpec>
  | Map<string, CommandRun | CommandSpec>

/** Options for {@link createTerminal}. */
export interface CreateTerminalOptions {
  /**
   * Directory at which the source tree is mounted. Defaults to `/`;
   * relative paths are resolved from `/`. Source keys are normalized within
   * this directory, including keys with a leading `/` or `..` components.
   * The mount and its ancestors exist even when the source map is empty.
   */
  mount?: string
  /**
   * Home path used by `~`, `$HOME`, and argumentless `cd`. Defaults to the
   * mount; relative paths are resolved from `/`. Does not create a directory
   * or change cwd. A shell assignment to `HOME` overrides this value.
   */
  home?: string
  /**
   * Opt into a separate, persistent in-memory writable overlay at `/tmp/`.
   * Only `/tmp/`, `false`, and `undefined` are accepted. Disabled by default.
   * Requires mount to be neither `/`, `/tmp`, nor a descendant of `/tmp`.
   * The source tree remains read-only. Missing parent directories are not
   * created by output redirection; `cp -r` is what makes a directory there. Unsupported streaming read/write overlap
   * and changes to inherited input files reach the diagnostic channel.
   */
  writable?: '/tmp/' | false | undefined
  /** Initial working directory. Normalized to an absolute path; defaults to the mount. */
  cwd?: string
  /** User name reported by `whoami`, and the owner `ls -l` shows for every entry. Defaults to `'user'`. */
  user?: string
  /**
   * Commands to add to the built-in set — the wiring point for anything this
   * package will not implement itself, such as a `sha256sum` whose hashing
   * comes from the host. Wired commands are dispatchable, pipeable, and
   * expandable like built-ins, and appear after them in completion and the
   * "Available: …" hint, in registration order.
   */
  commands?: Commands
}

/**
 * Options for {@link Terminal.fork}. What the terminal is *over* — the source
 * tree, the mount, the `/tmp/` overlay, the wired commands — belongs to the
 * parent and cannot be given another value here; an option this leaves out is
 * rejected rather than ignored, since `fork({ writable: false })` would
 * otherwise read as an isolation a fork does not provide.
 */
export interface ForkOptions {
  /**
   * Working directory the fork starts in. Defaults to where the parent stands
   * at the moment of the call; a relative path resolves from there, as a `cd`
   * would. Must name an existing directory.
   */
  cwd?: string
  /**
   * Home path used by `~`, `$HOME`, and argumentless `cd`. Defaults to the
   * parent's; a relative path resolves from the parent's working directory. A
   * `HOME` assignment inherited from the parent stands in front of it, exactly
   * as an assignment stands in front of {@link CreateTerminalOptions.home} —
   * which is the reason to pass `inherit: false` along with it.
   */
  home?: string
  /** User name reported by `whoami`. Defaults to the parent's. */
  user?: string
  /**
   * Whether to hand the fork the parent's shell state: its variables — the
   * names it knows to be unset included — its functions, and `$?`. `true` by
   * default, which is what makes this a fork.
   *
   * `false` starts that state empty, where a newly created terminal starts,
   * leaving the filesystem, the `/tmp/` overlay and the wired commands as the
   * only things shared. It is the companion to {@link ForkOptions.home} and
   * {@link ForkOptions.user}: a session under another name has no business
   * carrying the variables, the functions and the `HOME` assignment of the one
   * it came from. Where the fork stands is {@link ForkOptions.cwd}'s business
   * either way, inherited or not.
   */
  inherit?: boolean
}

/**
 * What kind of gap an {@link Unsupported} entry reports.
 *
 * - `command` — the name is not a registered command.
 * - `option` — a registered command was handed an option it does not
 *   implement, or explicitly rejects.
 * - `feature` — a construct this terminal recognizes and deliberately
 *   goes no further on: `&` backgrounding, `case` / `select` and the other
 *   shell blocks it does not implement, a loop that never ends, command substitution
 *   and arithmetic, the `${…}` parameter-expansion operators, shell
 *   builtins it lacks (`source`, `eval`, …), a variable
 *   nothing set (there is no environment: `$PATH` expands to nothing,
 *   with this entry), a redirect that would write a file against the
 *   filesystem without a writable overlay, unsupported `sed` commands or regex features,
 *   and the gawk features its `awk` refuses (`system()`, output pipes,
 *   writing to a file).
 */
export type UnsupportedKind = 'command' | 'option' | 'feature'

/** One gap in this implementation, hit while running a command line. */
export interface Unsupported {
  /** Which of the three gap classes this is. */
  kind: UnsupportedKind
  /** The command that reported it, as typed; `null` for a gap in the shell itself rather than in a command. */
  command: string | null
  /**
   * Short identifier for the missing construct, stable enough to switch on.
   * Usually the token as typed (`-prune`, `--bogus`, `frobnicate`, `>>`), but
   * normalized where one gap has several spellings: `tr -sd` and `tr -d -s`
   * both report `-d -s`; unsupported `sed` commands report `script`, while
   * unsupported regex features have their own identifiers.
   */
  detail: string
  /** Human-readable diagnostic: the same line the gap put on stderr, minus the trailing newline. Shell-level gaps omit the generic `error: ` prefix that stderr carries. */
  message: string
}

/** Result of running a command line through {@link Terminal.run}. */
export interface RunResult {
  /** Concatenated stdout from every stage that ran. */
  stdout: string
  /** Concatenated stderr from every stage that ran. */
  stderr: string
  /** Exit code of the last step that ran (0 if none did). */
  exitCode: number
  /** Working directory after the line completed. */
  cwd: string
  /**
   * Gaps in this implementation hit anywhere in the line — the diagnostic
   * channel, for callers driving the terminal programmatically.
   *
   * Frozen, empty when the line asked for nothing this terminal lacks, and
   * deduplicated: one entry per distinct gap however many times it was hit.
   *
   * These are *also* reported on {@link RunResult.stderr} exactly as before,
   * which is what an interactive user should see. The separate channel exists
   * because stderr belongs to the command, so the shell's ordinary plumbing is
   * free to discard it: `find . -prune -o -print 2>/dev/null | head` silences
   * the message and then replaces the exit code, leaving a missing option
   * indistinguishable from an empty tree. Nothing in a command line —
   * redirect, pipe, `&&` gate, or subshell — can suppress this list.
   *
   * Scope is gaps, not failures. A missing file, a `grep` that matched
   * nothing, or a `cd` into a non-directory are things GNU reports the same
   * way; they stay on stderr and never appear here.
   */
  unsupported: readonly Unsupported[]
  /**
   * Informational notes from execution and expansion, independent of stdout, stderr,
   * and exit status. Frozen and deduplicated per run; redirects, pipelines,
   * and nested shell commands cannot suppress them.
   *
   * Notes cover hidden entries omitted by `ls`, `tree` or pathname globs,
   * unmatched globs passed literally, input shortened by `head`/`tail`,
   * depth-limited traversal, grep binary/filter exclusions, and NUL bytes
   * discarded by command substitution. Omission lists include absolute paths
   * for fewer than 10 entries, otherwise a count. Notes describe what
   * happened and explain relevant option behavior, such as `ls -a` including
   * hidden entries. A glob names only the hidden entries its own pattern
   * would otherwise have taken, so `*.bar` reports `.bar` and says nothing
   * about `.foo.txt`.
   *
   * A command that fails inside an `&&` chain cancels the rest of it, and
   * that is noted where it actually stopped something from running — never
   * for `test`, `[`, `true`, `false` or `grep -q`, whose status is the point
   * of the gate.
   *
   * A file or directory access failure whose diagnostic went to `/dev/null`
   * or a closed descriptor is noted too, naming the command, the reason and
   * the paths it applied to. Not when the message reached stderr anyway, and
   * not when another note already accounts for that path.
   *
   * A failed file lookup also notes verified alternatives under the session's
   * other roots: `/`, the mount, and the home. A relative path was looked up
   * from the current directory and an absolute one from `/`, so the note asks
   * whichever roots are left whether the same path names something there —
   * which is what answers a `cat /src/app.js` over a tree mounted at `/repo`.
   * Roots that coincide, and roots that lead to the same file, are reported
   * once. A single alternative is identified as a file or dir; several are
   * listed together, with content differences noted when every one of them is
   * a file; directory contents are not compared.
   * These hints preserve the original error and do not accompany silent
   * existence probes. Notes never enable features or change command results.
   */
  notes: readonly string[]
}

/**
 * The parser's own vocabulary, shared with the `@preventive/terminal/parse.js`
 * entry point: what {@link Terminal.parse} hands back, and the nodes it is
 * made of.
 */
export type {
  ArithmeticPart,
  Assignment,
  BracePart,
  ChainBraces,
  ChainFor,
  ChainParens,
  ChainRow,
  ChainWhile,
  Branch,
  Chain,
  CloseRedirect,
  Command,
  Condition,
  ConditionBinary,
  ConditionJunction,
  ConditionNot,
  ConditionUnary,
  DuplicateRedirect,
  FileRedirect,
  ForLoop,
  FunctionDefinition,
  Group,
  HereDocument,
  HereString,
  If,
  Node,
  NodeBase,
  Operator,
  Part,
  Parts,
  PatternPart,
  ParseResult,
  Pipeline,
  ProcessPart,
  ProcessToken,
  Redirect,
  ShellToken,
  Subshell,
  StringPatternPart,
  SubstitutionPart,
  Summary,
  AssignmentsToken,
  Test,
  Token,
  TokenAssignment,
  TokenParts,
  TokenPiece,
  Value,
  VariablePart,
  WhileLoop,
  WordToken,
} from './parse.js'

/** A virtual terminal instance with a mutable cwd carried across {@link Terminal.run} calls. */
export interface Terminal {
  /**
   * Parse and execute one command line: pipelines, `&&` / `||` / `;`
   * gates, `!`, `(...)` subshells and `{ …; }` groups, `for … in …; do …;
   * done` loops with `break` / `continue`, `exit`, `NAME=value`
   * assignments (`export` / `unset`, and in front of a command),
   * `if` branches and `[[ … ]]` file/string/integer conditionals,
   * redirects (`>` `>>` `2>` `&>` to `/dev/null`, the two stream
   * devices, or files in an enabled `/tmp/` overlay; `2>&1`, `>&-`,
   * `<`, `<<`, `<<<`),
   * comments, bash quoting and backslash rules, brace expansion with
   * sequences, `~`, `$NAME` / `$?`, command substitution, scalar `$(( … ))`
   * arithmetic, `${…}` defaults, assignment, length, substring extraction,
   * pattern replacement and prefix/suffix removal,
   * and globs with bracket expressions. Other expansion operators, arrays,
   * and `[[ … =~ … ]]` report unsupported diagnostics. Variables and the
   * working directory persist across calls.
   */
  run(line: string): RunResult
  /** Current working directory. */
  cwd(): string
  /**
   * Tab-completion. Each entry is a full-line replacement for `line` —
   * the partial trailing word is filled in, everything before it (prior
   * args, separators, whitespace) is preserved verbatim. Consumers can
   * drop a result in without tokenizing the input themselves: e.g.
   * `complete('cat|gre')` returns `['cat|grep']`.
   *
   * In command position — the start of the line, or after `;`, a newline,
   * `|`, `&&`, `||`, `(`, or a `for` loop's `do` — completes command names
   * (including under bin prefixes like `/usr/bin/`). In argument position, walks the virtual
   * FS treating the trailing word as a path (relative to cwd unless it
   * starts with `/` or unquoted `~/`); directories carry a trailing `/`.
   * Quoted and escaped filenames are supported, and suggested suffixes are
   * quoted for literal shell use. Returns `[]` when nothing matches or when
   * completing the prefix would require evaluating an expansion.
   */
  complete(line: string): string[]
  /**
   * Fork this terminal: a second terminal over the same filesystem, carrying a
   * copy of this one's session state — the working directory, the variables,
   * the shell functions, and `$?` as they are at the moment of the call.
   *
   * It is the process fork rather than a second {@link createTerminal}: the
   * source tree, the mount, the `/tmp/` overlay, and the wired commands are
   * this terminal's own, not copies. Afterwards the two run independently —
   * neither one's `cd`, assignment, `unset`, or function definition is visible
   * to the other, in either direction — and what they write in `/tmp/` is the
   * one thing that passes between them, as it does between two processes
   * sharing a disk. With no writable overlay they share nothing but the
   * read-only sources.
   *
   * Each terminal's {@link RunResult} is its own: `unsupported` and `notes`
   * report the line that terminal ran, and nothing else.
   *
   * {@link ForkOptions.inherit} set to `false` withholds that copy — no
   * variables, no functions, no `$?` — for a fork that shares the filesystem
   * and nothing of the session.
   *
   * @throws if `opts` is not an object, carries an option a fork cannot honor,
   * or sets `inherit` to anything but a boolean.
   * @throws if `opts.cwd` or `opts.home` is not a string or contains a NUL.
   * @throws if `opts.cwd` does not resolve to an existing directory.
   */
  fork(opts?: ForkOptions): Terminal
  /**
   * Read a command line without running any of it: whether it parses, whether
   * it is merely unfinished, the diagnostic if it is neither, and the commands
   * it holds — enough to read its arguments, render it, or run it elsewhere.
   * Nothing is executed and nothing changes: not the working directory, the
   * variables, or the `/tmp/` overlay.
   *
   * The same reading as the `@preventive/terminal/parse.js` entry point, which
   * needs no terminal, plus the one thing only a terminal knows: a redirect
   * this filesystem would refuse is reported here as the gap `run()` reports.
   */
  parse(line: string): ParseResult
  /**
   * What the line runs, at a glance: one {@link Chain} per command, each
   * holding its pipeline stages' `argv` and its redirects as written, with
   * `&&` and `||` standing between the chains they gate and `&` after the one
   * it hands to the background. It reports what the
   * line does rather than how it was spelled, so whatever feeds a command is
   * the command that feeds it: `wc < 1.txt` summarizes as
   * `[['cat', '1.txt'], ['wc']]`, and `cat > notes.md <<EOF … EOF` as
   * `[['echo', '…'], ['>', 'notes.md']]`, the pass-through `cat` left out.
   *
   * A token is text, a {@link PatternPart} or {@link VariablePart}, the
   * {@link ShellToken} whose output a word will be, the {@link TokenParts}
   * those join into — a `~` among them, which reads as the `$HOME` it names —
   * or the {@link AssignmentsToken} a command carries. It
   * throws rather than summarize what it cannot: a line
   * that does not parse (including a redirect this filesystem would refuse),
   * an `if` or `[[ … ]]`, a `!`, a
   * here-document whose delimiter leaves its body to expand, an operand or a
   * sum that would run a command behind a reader, a stage reading
   * its own input from inside a pipeline, or a word a command has to run before
   * its text is known.
   * {@link Terminal.parse} reads those.
   *
   * @throws if the line does not parse, or holds anything but simple chains.
   */
  summarize(line: string): Summary
}

/**
 * Create an in-memory terminal over a `{ path: content }` source tree.
 *
 * @throws if `opts.cwd` does not resolve to an existing directory.
 * @throws if `opts.mount`, `opts.home`, or `opts.cwd` is not a string or contains a NUL.
 * @throws if a source path contains a NUL.
 * @throws if `opts.writable` has another value or enables writes with a mount
 * at `/`, `/tmp`, or inside `/tmp`.
 * @throws if `opts.commands` is not a plain object or a `Map`, or if an entry
 * in it has a non-string or unusable name, redefines a built-in command, or is
 * not a function or `{ run }` object.
 */
export function createTerminal(sources: Sources, opts?: CreateTerminalOptions): Terminal
