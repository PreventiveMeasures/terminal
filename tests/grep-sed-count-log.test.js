import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'workspace/nested/keep.txt': 'ignored\n',
  'd/src.js': `import b '@a/core';
b '@a/alpha';
b '@a/beta';
b '@a/core';
const decoy = '@a/false';
b '@b/wrong';
b "@a/double";
b '@a/core'; b '@a/omega';
const before = '@a/ignored'; b '@a/beta'; const after = '@a/after';
`,
  'w/plugin.mjs': `b '@a/core';
b '@a/alpha';
b '@a/beta';
`,
  'w/nested/widget.js': `b '@a/core';
b '@a/omega';
b '@a/alpha';
`,
}

const COMMAND = String.raw`cd / && grep -rhn "b '@a/[^']*'" d w 2>/dev/null | sed "s/.*b '\(@a\/[^']*\)'.*/\1/" | sort | uniq -c | sort -rn | head -20`
const CASES = [
  {
    purpose: 'the exact logged pipeline extracts captures and counts packages after returning to root',
    command: COMMAND,
    files: FILES,
    cwd: '/workspace/nested',
    stdout: `      4 @a/core
      3 @a/beta
      3 @a/alpha
      2 @a/omega
`,
  },
  {
    purpose: 'the sed stage chooses the last matching package and leaves nonmatching lines unchanged',
    command: String.raw`cat d/src.js | sed "s/.*b '\(@a\/[^']*\)'.*/\1/"`,
    files: FILES,
    cwd: '/',
    stdout: `@a/core
@a/alpha
@a/beta
@a/core
const decoy = '@a/false';
b '@b/wrong';
b "@a/double";
@a/omega
@a/beta
`,
  },
  {
    purpose: 'a source tree without the requested package syntax yields an ordinary empty pipeline',
    command: COMMAND,
    files: {
      'workspace/nested/keep.txt': 'ignored\n',
      'd/src.js': "b '@b/other'\n",
      'w/plugin.mjs': 'b "@a/double"\n',
    },
    cwd: '/workspace/nested',
    stdout: '',
  },
  ...[
    ['ordinary lines', 'a\nb\n', ' a\n b\n'],
    ['blank lines', '\na\n\n', ' \n a\n \n'],
    ['an unterminated final line', 'a\nb', ' a\n b'],
    ['empty input', '', ''],
  ].flatMap(([inputKind, input, stdout]) => ["sed 's/^/ /'", "sed -e 's/^/ /'"].map((command) => ({
    purpose: `${command} handles ${inputKind}`,
    command: 'cat input | ' + command,
    files: { input },
    cwd: '/',
    stdout,
  }))),
]

describe('grep and sed — logged package-count pipeline', () => {
  for (const { purpose, command, files, cwd, stdout } of CASES) {
    it(purpose, () => {
      const result = createTerminal(files, { cwd }).run(command)
      assert.deepEqual(result, { stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] }, command)
    })
  }
})
