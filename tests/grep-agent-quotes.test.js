import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'nm/a.js': `const a = {[K]: 'R'};
const b = {[K]: "R"};
const c = {[K]:"R"};
const miss = {[K]: 'Q'};
const tab = {[K]:\t'R'};
const other = {[J]: 'R'};
`,
  'nm/b.mjs': `[K]:  'R',
[K]:"R",
[K]: 'RR',
[K]: R,
`,
  'nm/z.txt': "[K]: 'R'\n",
  'nm/nested/c.js': `nested({[K]: "R"});
nested({[K]: 'R'});
`,
  'nm/nested/d.mjs': "[K]: 'R'\n",
  'nm/nested/e.json': '[K]: "R"\n',
  'nm/b.json': '{\n "name": "@a/b",\n "other": "@a/b-extra"\n}\n',
  'nm/nested/b.json': '{"dependencies":{"@a/b":"^1.0"}}\n',
  'nm/nested/other.json': '{"name":"@a/b"}\n',
  'a/main.ts': `const single = 'a'\nconst double = "a"\nconst other = 'ab'\n`,
  'a/main.txt': "'a'\n",
  'a/one/b.json': '{"name":"@a/b","token":"a"}\n',
  'a/two/b.json': '{"name":"@a/b-extra","token":"z"}\n',
  'a/three/b.json': '{"name":"@a/c"}\n',
  'b/main.js': 'export default "a"\n',
  'b/source.mjs': "export const value = 'a'\n",
  'b/config.json': '{"value":"a"}\n',
  'c/one/b.json': '{"name":"@a/b"}\n',
  'f/1.txt': Array.from({ length: 24 }, (_, i) => `skip ${i + 1}\n${['a', 'b', 'c d', 'e'][i % 4]} ${i + 1}\n`).join(''),
  'dir1/a.ts': 'const X = 1\nconst Y = 2\n',
  'dir1/b.tsx': 'export const X = <div />\n',
  'dir1/c.js': 'const X = false\n',
  'dir2/a.ts': 'X = 3\nX = nm\n',
  'dir2/nm.ts': 'X = 4\n',
  'dir2/nm/d.ts': 'X = 5\n',
  'dir2/nested/ui.tsx': 'export { X }\n',
  file: `{
  "a": false,
  "d": true,
  "detail": "word d",
  "tail": 1
}
`,
}

const MATCHES = `nm/a.js:1:const a = {[K]: 'R'};
nm/a.js:2:const b = {[K]: "R"};
nm/a.js:3:const c = {[K]:"R"};
nm/b.mjs:1:[K]:  'R',
nm/b.mjs:2:[K]:"R",
nm/nested/c.js:1:nested({[K]: "R"});
nm/nested/c.js:2:nested({[K]: 'R'});
nm/nested/d.mjs:1:[K]: 'R'
`

const LIMITED_MATCHES = `2:a 1
4:b 2
6:c d 3
8:e 4
10:a 5
12:b 6
14:c d 7
16:e 8
18:a 9
20:b 10
22:c d 11
24:e 12
26:a 13
28:b 14
30:c d 15
32:e 16
34:a 17
36:b 18
38:c d 19
40:e 20
`

const CASES = [
  {
    purpose: 'the exact reported agent command retains embedded single and escaped double quotes',
    command: String.raw`grep -rn "K\]: *['\"]R['\"]\|K\]:\"R\"" nm --include="*.mjs" --include="*.js" | head -20`,
    stdout: MATCHES,
  },
  {
    purpose: 'escaped apostrophes join adjacent single-quoted pattern fragments',
    command: String.raw`grep -rn 'K\]: *['\''"]R['\''"]\|K\]:"R"' nm --include='*.mjs' --include='*.js' | head -20`,
    stdout: MATCHES,
  },
  {
    purpose: 'double-quoted apostrophes join adjacent single-quoted pattern fragments',
    command: String.raw`grep -rn 'K\]: *['"'"'"]R['"'"'"]\|K\]:"R"' nm --include='*.mjs' --include='*.js' | head -20`,
    stdout: MATCHES,
  },
  {
    purpose: 'a quoted variable preserves regex backslashes and embedded quote characters',
    command: String.raw`PATTERN="K\]: *['\"]R['\"]\|K\]:\"R\""; grep -rn "$PATTERN" nm --include="*.mjs" --include="*.js" | head -20`,
    stdout: MATCHES,
  },
  {
    purpose: 'separate pattern operands support independently quoted alternatives',
    command: String.raw`grep -rn -e "K\]: *['\"]R['\"]" -e 'K\]:"R"' nm --include="*.mjs" --include="*.js" | head -20`,
    stdout: MATCHES,
  },
  {
    purpose: 'a correctly quoted pattern with no matches remains an ordinary empty pipeline',
    command: String.raw`grep -rn "K\]: *['\"]Z['\"]\|K\]:\"Z\"" nm --include="*.mjs" --include="*.js" | head -20`,
    stdout: '',
  },
  {
    purpose: 'the reported multiple-include command accepts quoted equals values and filters both roots',
    command: String.raw`grep -rn "X" --include='*.ts' --include='*.tsx' dir1 dir2 | grep -v nm | head -30`,
    stdout: `dir1/a.ts:1:const X = 1
dir1/b.tsx:1:export const X = <div />
dir2/a.ts:1:X = 3
dir2/nested/ui.tsx:1:export { X }
`,
  },
  {
    purpose: 'the reported escaped-quote pattern reaches grep without a trailing backslash',
    command: String.raw`grep -rn "\"d\"" -A 60 file | head -80`,
    stdout: `3:  "d": true,
4-  "detail": "word d",
5-  "tail": 1
6-}
`,
  },
  {
    purpose: 'the reported quote-character class accepts unquoted include globs and suppressed stderr',
    command: String.raw`grep -rn "['\"]a['\"]" --include=*.ts --include=*.js --include=*.mjs --include=*.json a b 2>/dev/null | head -30`,
    stdout: `a/main.ts:1:const single = 'a'
a/main.ts:2:const double = "a"
a/one/b.json:1:{"name":"@a/b","token":"a"}
b/config.json:1:{"value":"a"}
b/main.js:1:export default "a"
b/source.mjs:1:export const value = 'a'
`,
  },
  {
    purpose: 'the reported scoped-package search preserves both literal double quotes',
    command: String.raw`grep -rn "\"@a/b\"" nm --include=b.json | head -10`,
    stdout: `nm/b.json:2: "name": "@a/b",
nm/nested/b.json:1:{"dependencies":{"@a/b":"^1.0"}}
`,
  },
  {
    purpose: 'the reported quoted-prefix pattern ends correctly before wildcard path operands',
    command: String.raw`grep -rn "\"@a/b" a/*/b.json c/*/b.json | head`,
    stdout: `a/one/b.json:1:{"name":"@a/b","token":"a"}
a/two/b.json:1:{"name":"@a/b-extra","token":"z"}
c/one/b.json:1:{"name":"@a/b"}
`,
  },
  {
    purpose: 'the reported max-count option accepts a quoted BRE alternation before a head stage',
    command: String.raw`grep -n "a\|b\|c d\|e" -m 20 f/1.txt | head -20`,
    stdout: LIMITED_MATCHES,
  },
  {
    purpose: 'max-count itself stops after 20 matches without a head stage concealing extra output',
    command: String.raw`grep -n "a\|b\|c d\|e" -m 20 f/1.txt`,
    stdout: LIMITED_MATCHES,
  },
]

describe('grep — agent quoting regressions', () => {
  for (const { purpose, command, stdout } of CASES) {
    it(purpose, () => {
      const result = createTerminal(FILES).run(command)
      assert.deepEqual(
        [result.stdout, result.stderr, result.exitCode, result.unsupported],
        [stdout, '', 0, []],
        command,
      )
    })
  }
})

describe('grep — quoted assignment fragments', () => {
  const command = String.raw`grep -n "a\|b c\|e += \"; f=\"\|e += \"; g=\"\|a b = c" f/d.txt`
  const selected = ['a', 'b c', 'e += "; f="', 'e += "; g="', 'a b = c']
  const decoys = ['b  c', 'e = "; f="', 'e += "; h="', "e += '; f='", 'e+ = "; g="', 'e += "; g=\'']
  const files = {
    'f/d.txt': ['skip', ...selected, ...decoys].join('\n') + '\n',
    'other.txt': 'a\n',
  }

  it('the reported command preserves all five BRE alternatives and literal quotes, semicolons and plus signs', () => {
    assert.deepEqual(createTerminal(files).run(command), {
      stdout: selected.map((line, i) => `${i + 2}:${line}\n`).join(''),
      stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
  })

  it('retains the longest alternative when a shorter one starts at the same position', () => {
    assert.deepEqual(createTerminal(files).run(command.replace('grep -n', 'grep -on')), {
      stdout: selected.map((line, i) => `${i + 2}:${line}\n`).join(''),
      stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
  })
})
