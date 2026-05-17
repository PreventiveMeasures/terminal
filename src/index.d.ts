/** Virtual source tree: a map of absolute-or-relative paths to file contents. */
export interface Sources {
  [path: string]: string
}

/** Options for {@link createTerminal}. */
export interface CreateTerminalOptions {
  /** Initial working directory. Normalized to an absolute path; defaults to `/`. */
  cwd?: string
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
  /** Parse and execute one command line (pipelines, `&&` / `||` / `;` gates, redirects). */
  run(line: string): RunResult
  /** Current working directory. */
  cwd(): string
}

/** Create an in-memory terminal over a `{ path: content }` source tree. */
export function createTerminal(sources: Sources, opts?: CreateTerminalOptions): Terminal
