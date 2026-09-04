/** Virtual source tree: file paths (leading `/` optional) to file contents, as either a plain object or a `Map`. */
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
  /** Immediate children of directory `path`, each list sorted. Throws if `path` is not a directory. */
  listDir(path: string): { dirs: string[]; files: string[] }
  /** Every file path at or under `path`, absolute. Empty if `path` does not exist. */
  walkFiles(path: string): string[]
}

/** One readable input: a named file, or stdin (`name: null`). */
export interface CommandInput {
  /** The operand as it was typed, or `null` for stdin. */
  name: string | null
  /** File contents, or the piped stdin string. */
  content: string
}

/** Result of {@link CommandIo.readInputs}: the coreutils partial-failure model. */
export interface CommandInputs {
  /** Inputs that could be read, in operand order. */
  inputs: CommandInput[]
  /** One `cmd: path: reason` line per unreadable operand. */
  stderr: string
  /** True if any operand failed; conventionally exit 1 while still emitting what did read. */
  failed: boolean
}

/** Everything a wired command is given. Read-only: a handler cannot change the terminal's cwd or the source tree. */
export interface CommandIo {
  /** The name this command was registered under. */
  name: string
  /** Operands after the command name, with brace and glob expansion already applied. */
  args: string[]
  /** Stdin from the previous pipeline stage; `''` when the command starts a pipeline. */
  stdin: string
  /** Absolute working directory at the time of the call. */
  cwd: string
  /** Read-only view of the virtual source tree. */
  fs: CommandFs
  /** Read each path, collecting errors instead of aborting. An empty list yields one nameless input carrying {@link CommandIo.stdin}. */
  readInputs(paths: readonly string[]): CommandInputs
}

/** What a {@link CommandRun} handler may return in place of a plain string. Missing fields default to `''` / `0`. */
export interface CommandResult {
  stdout?: string
  stderr?: string
  /** Non-negative integer; gates `&&` / `||` like any other command's status. */
  exitCode?: number
}

/**
 * A wired command's implementation. Returning a string is shorthand for that
 * stdout with exit 0, and returning nothing is a silent success. Must be
 * synchronous — the engine feeds one stage's stdout to the next with no await
 * point, so a returned promise is rejected rather than stringified into the
 * stream. Throwing is fine: the message surfaces as a `name: message` stderr
 * line with exit 1, exactly like a built-in command's internal error.
 */
export type CommandRun = (io: CommandIo) => string | CommandResult | void

/** A wired command with its registry metadata. A bare {@link CommandRun} is shorthand for `{ run }`. */
export interface CommandSpec {
  run: CommandRun
  /** Offer this command as a completion target after `|`. Set it when the handler reads `stdin`. Defaults to `false`. */
  pipe?: boolean
  /** Keep the command dispatchable (and resolvable by `which`) but out of completion and the "Available: …" hint. Defaults to `false`. */
  hidden?: boolean
}

/** Commands to wire in, keyed by the name they are typed as. */
export type Commands =
  | Record<string, CommandRun | CommandSpec>
  | Map<string, CommandRun | CommandSpec>

/** Options for {@link createTerminal}. */
export interface CreateTerminalOptions {
  /** Initial working directory. Normalized to an absolute path; defaults to `/`. */
  cwd?: string
  /** User name reported by `whoami`. Defaults to `'user'`. */
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
}

/** A virtual terminal instance with a mutable cwd carried across {@link Terminal.run} calls. */
export interface Terminal {
  /** Parse and execute one command line (pipelines, `&&` / `||` / `;` gates, `(...)` subshells, redirects). */
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
   * In command position, completes command names (including under bin
   * prefixes like `/usr/bin/`). In argument position, walks the virtual
   * FS treating the trailing word as a path (relative to cwd unless it
   * starts with `/`); directories carry a trailing `/`. Returns `[]`
   * when nothing matches.
   */
  complete(line: string): string[]
}

/**
 * Create an in-memory terminal over a `{ path: content }` source tree.
 *
 * @throws if `opts.cwd` does not resolve to an existing directory.
 * @throws if an entry in `opts.commands` has an unusable name, redefines a
 * built-in command, or is not a function or `{ run }` object.
 */
export function createTerminal(sources: Sources, opts?: CreateTerminalOptions): Terminal
