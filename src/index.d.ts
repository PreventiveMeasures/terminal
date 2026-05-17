export interface Sources {
  [path: string]: string
}

export interface CreateTerminalOptions {
  cwd?: string
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  cwd: string
}

export interface Terminal {
  run(line: string): RunResult
  cwd(): string
}

export function createTerminal(sources: Sources, opts?: CreateTerminalOptions): Terminal
