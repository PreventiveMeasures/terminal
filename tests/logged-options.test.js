import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'src/app.js': 'alpha\n',
  'src/main.ts': 'alpha\nbeta\nalpha beta\n',
  'src/dir/skip.ts': 'alpha\n',
  'src/other.txt': 'beta\n',
  'binary': 'alpha\0beta\n',
  'lines': 'one\ntwo\nthree\n',
  'records': 'id=no\nid=42\nid=7\n',
  'table': 'b:2\na:3\nc:1\n',
  'controls': 'a\tb\n\n',
}

// Each option spelling is taken from the reported command logs.
const CASES = [
  ["find src -ipath '*/APP.JS'", 'src/app.js\n'],
  ['grep -I alpha binary', '', 1],
  [String.raw`grep -Pn '(?<=id=)\d+' records`, '2:id=42\n3:id=7\n'],
  ['tree -L1 --noreport src', 'src\n├── app.js\n├── dir\n├── main.ts\n└── other.txt\n'],
  ['grep -rn alpha src --exclude-dir=dir', 'src/app.js:1:alpha\nsrc/main.ts:1:alpha\nsrc/main.ts:3:alpha beta\n'],
  ["grep -rn alpha src --include '*.js'", 'src/app.js:1:alpha\n'],
  ["sort -t: -k2,2n table", 'c:1\nb:2\na:3\n'],
  ['tail -c6 lines', 'three\n'],
  ['cat -A controls', 'a^Ib$\n$\n'],
  ["grep -rn beta src --include='*'", 'src/main.ts:2:beta\nsrc/main.ts:3:alpha beta\nsrc/other.txt:1:beta\n'],
  ['grep -xn alpha src/main.ts', '1:alpha\n'],
  ['ls -d src', 'src\n'],
  ["grep -rn alpha src --include='*.js'", 'src/app.js:1:alpha\n'],
  ["grep -rn alpha --exclude-dir=dir src", 'src/app.js:1:alpha\nsrc/main.ts:1:alpha\nsrc/main.ts:3:alpha beta\n'],
  ['nl -ba -v45 lines', '    45\tone\n    46\ttwo\n    47\tthree\n'],
  ["echo src/app.js | xargs -I{} cat {}", 'alpha\n'],
  ["find src -iname 'APP.JS'", 'src/app.js\n'],
  ['grep -nm1 alpha src/main.ts', '1:alpha\n'],
  ['head -c3 lines', 'one'],
  ["grep -rn alpha src --include='*.ts'", 'src/dir/skip.ts:1:alpha\nsrc/main.ts:1:alpha\nsrc/main.ts:3:alpha beta\n'],
  ["find src -name dir -prune -o -type f -print", 'src/app.js\nsrc/main.ts\nsrc/other.txt\n'],
]

describe('options from historical agent command logs', () => {
  for (const [command, stdout, exitCode = 0] of CASES) {
    it(command, () => {
      const result = createTerminal(FILES).run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, exitCode)
      assert.deepEqual(result.unsupported, [])
    })
  }
})
