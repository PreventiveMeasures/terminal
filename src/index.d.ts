/**
 * What a source entry is where a string or a `Uint8Array` cannot say it, in
 * the shapes `@preventive/vfs` declares an entry with. `{ type: 'file', data }`
 * is a file, `data` its text or its bytes, and nothing for an empty file;
 * `{ type: 'directory' }` a directory, which need hold nothing; and
 * `{ type: 'symlink', target }` a symbolic link, holding the path it carries,
 * resolved from the directory the link itself is in, exactly as the kernel
 * resolves one. The target need not exist — a link leading nowhere is a link,
 * and `find -type l` and `ls -l` say so — and an absolute target names a path
 * in the terminal's own filesystem rather than one inside the mount. Bytes
 * spelt in base64, `{ format: 'base64', data }` (RFC 4648, padded or not), are
 * the file a `Uint8Array` of the same bytes would be, for a tree that arrives
 * serialized as text, decoded when the terminal is made. A hard link, and a
 * `mode` or an `mtime`, are what a Vfs holds and this terminal does not keep
 * yet: declaring one is refused, as is any field an entry's type does not
 * have.
 */
export type SourceEntry =
  | { type: 'file'; data?: string | Uint8Array }
  | { type: 'directory' }
  | { type: 'symlink'; target: string }
  | { format: 'base64'; data: string }

/**
 * Virtual source tree: paths within the configured mount (leading `/`
 * optional) to what is there, as either a plain object or a `Map`. A file is
 * the text it holds, or — for one no string can spell, such as an image or a
 * compiled object — the bytes themselves, as a `Uint8Array` that is copied
 * when the terminal is made; anything else is a {@link SourceEntry}. Parent
 * directories are implied. The tree follows `@preventive/vfs`'s rules for a
 * map: two spellings of one path (`a/f`, `./a/f`) are one name, declared again
 * only as the same entry; nothing is declared under a file or through a link;
 * a name is at most 255 bytes of UTF-8; and text must have a UTF-8 encoding,
 * which text holding a lone surrogate has not. A source that breaks a rule,
 * or declares nothing — `null`, a number, an object without a type — makes
 * `createTerminal` throw a `TypeError` naming it.
 */
export type Sources = Record<string, string | Uint8Array | SourceEntry> | Map<string, string | Uint8Array | SourceEntry>

/** Read-only view of the virtual source tree, handed to a {@link CommandRun} handler. Paths may be relative to {@link CommandIo.cwd}. */
export interface CommandFs {
  /** Absolutize and normalize `path` against the current working directory. */
  resolve(path: string): string
  /** Whether `path` names a file in the source tree. */
  isFile(path: string): boolean
  /** Whether `path` names a directory, declared as one or implied by the paths below it. */
  isDir(path: string): boolean
  /** Whether `path` itself names a symbolic link — the name is not followed, as `lstat` does not follow one. Every other method here resolves links on the way, and `path` reaching through one is resolved for this check too. */
  isLink(path: string): boolean
  /** The path a symbolic link holds, unresolved, or `undefined` if `path` is not one. */
  readLink(path: string): string | undefined
  /** Whether `path` names a file, every one of which holds bytes: a file declared as text holds what the text encodes to as UTF-8. Its bytes may spell text, which {@link CommandFs.readFile} then reads, or may not, which {@link CommandFs.readBytes} reads. */
  isBytes(path: string): boolean
  /** Contents of `path`, or `undefined` if it is not a file. Throws where the file holds bytes that spell no text, as this string-based terminal cannot carry them out; {@link CommandFs.readBytes} reads those. */
  readFile(path: string): string | undefined
  /** The bytes of `path`, or `undefined` if it is not a file — what a file declared as a `Uint8Array` holds, and what the text of any other file encodes to as UTF-8. */
  readBytes(path: string): Uint8Array | undefined
  /** Immediate children of directory `path`, each list sorted (copies — mutating them cannot affect the tree). Links are listed apart from the files they may lead to. Throws `<path>: Not a directory` / `No such file or directory` otherwise. */
  listDir(path: string): { dirs: string[]; files: string[]; links: string[] }
  /** Every file path at or under `path`, absolute. `path` resolves as it does everywhere else here, so a link naming a directory walks the directory it names; a link the walk then reaches is neither crossed nor named. Empty if `path` does not exist. */
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
  /**
   * Run a line on the terminal this command is running in, inside this
   * command's turn: it is part of the line that reached the handler rather
   * than a turn of its own, and it sees the filesystem, the cwd and the
   * variables as they stand. Its diagnostics are its own — `unsupported` and
   * `notes` report what happened beneath this call and nothing of the line
   * around it.
   *
   * This is how a handler re-enters, and {@link Terminal.run} is not: that
   * one waits for a turn, as every caller of it does, and a handler waiting
   * there would be waiting for the turn it is itself holding. Which caller a
   * `run` came from cannot be read off the call — the handler and a consumer
   * that called during its wait arrive alike — so the terminal does not
   * guess, and a handler says which it is by using this.
   */
  run(line: string): Promise<RunResult>
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
 * stdout with exit 0, and returning nothing is a silent success. It may also
 * answer with a promise of either: the line waits for it where it stands, as
 * it waits for any command with work of its own, and the stage after it reads
 * what the promise resolved to. Throwing is fine, and the thrown value need
 * not be an `Error`: its message (or the value itself) surfaces as a
 * `name: reason` stderr line with exit 1, exactly like a built-in command's
 * internal error, leaving the rest of the command line to run its gates
 * normally. A promise that rejects fails the command the same way.
 *
 * A handler that runs a line of its own uses {@link CommandIo.run}, not the
 * terminal's — see there for why.
 */
export type CommandRun = (io: CommandIo) => string | CommandResult | void | Promise<string | CommandResult | void>

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
   * created by output redirection; `mkdir` and `cp -r` are what make one there,
   * and `rm -r` is what takes it away — except for `/tmp` itself, which is
   * where the overlay is mounted rather than something inside it. Unsupported streaming read/write overlap
   * and changes to inherited input files reach the diagnostic channel.
   */
  writable?: '/tmp/' | false | undefined
  /** Initial working directory. Normalized to an absolute path; defaults to the mount. */
  cwd?: string
  /** User name reported by `whoami`, and the owner `ls -l` shows for every entry. Defaults to `'user'`. */
  user?: string
  /**
   * The locale the terminal runs in. Only C.UTF-8 is implemented, so only that
   * is accepted — spelt as glibc spells it, `'C.UTF-8'` or `'C.utf8'` in
   * either case — and it is the default. `$LANG` answers it; a shell assignment that would move the
   * character set — `LANG`, `LC_ALL` or `LC_CTYPE` set to any other value,
   * or `LANG` unset — is refused with an unsupported diagnostic, while the
   * other `LC_` categories also take `C` and `POSIX`, which read the same
   * as C.UTF-8 in them. A fork keeps the locale of the terminal it came from.
   * @throws if any other value is given.
   */
  locale?: string
  /**
   * Whether this terminal may reach the network, which is what puts `curl` in
   * it. `false` by default, and everything else here is over a tree that
   * exists only in memory, so a terminal created without this has no command
   * that can make a request: the name is not found, exactly as it was before
   * the command was written. A line running in the terminal is told nothing
   * more than that, since how the terminal was built is yours rather than
   * its. `true` needs a `fetch` in the runtime to make the request with; a
   * runtime without one leaves the command out for the same reason a runtime
   * whose streams do not know a compression format leaves `brotli` out.
   *
   * There is nothing narrower to ask for: `true` is whatever the runtime's
   * own `fetch` can reach, over http and https alone. A caller who needs an
   * allow-list, a proxy or credentials of their own leaves this off and wires
   * a `curl` of their own through {@link CreateTerminalOptions.commands},
   * which the name is free for while the network is off.
   * @throws if it is anything but a boolean.
   */
  network?: boolean
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
 * tree, the mount, the `/tmp/` overlay, the network, the wired commands —
 * belongs to the parent and cannot be given another value here; an option this leaves out is
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
 * The parser's own vocabulary, re-exported from the
 * `@preventive/terminal/parse.js` entry point: what `parse(line)` hands back,
 * and the nodes it is made of. Reading a line is that entry point's alone — a
 * terminal runs one.
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
   *
   * A line is run when the call is made and answered with a promise,
   * because a command may have work the runtime does rather than this code —
   * `gzip` waits on a compression stream — and the line waits for it where
   * it meets it. One line runs at a time over a tree: a line handed to this
   * terminal, or to a fork of it, while another is in flight takes its turn
   * rather than starting in the gap that one left, so calls made without
   * awaiting the first still run in the order they were made — a wired
   * command that waits is waited for like any other, and a handler that
   * wants to run a line inside its own turn has {@link CommandIo.run} for
   * it. A failing line is reported in the result, as before; the promise
   * rejects only with what `run` would have thrown.
   */
  run(line: string): Promise<RunResult>
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
