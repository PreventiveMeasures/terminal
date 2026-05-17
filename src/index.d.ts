/** Virtual source tree: file paths (leading `/` optional) to file contents, as either a plain object or a `Map`. */
export type Sources = Record<string, string> | Map<string, string>

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
 */
export function createTerminal(sources: Sources, opts?: CreateTerminalOptions): Terminal
