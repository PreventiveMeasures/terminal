// The three-field shape every command returns. No dependencies: the
// diagnostics in unsupported.js are built from these, and so is every
// command's output, without either side reaching for the other.

export const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 })

// Terminate stderr once so consecutive errors stay on separate lines.
export const err = (msg, code = 1) => ({
  stdout: '',
  stderr: msg.endsWith('\n') ? msg : msg + '\n',
  exitCode: code,
})

// coreutils exits 1 when it cannot read the command line at all; grep and the
// two that walk a tree — ls and sort — exit 2 for everything.
export const usage = (line, code = 1) => err(`usage: ${line}`, code)
