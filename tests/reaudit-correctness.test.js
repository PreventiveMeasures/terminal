import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { after, describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'
import { materialize, missing, native } from './helpers/source-tree-reference.js'

const FILES = {
  f: 'b 2\na 1\na 1\nx 0\n',
  u: 'é😀\n',
  'src/a.js': 'export const a = 1\n',
}
const SUPPORTED = [
  [String.raw`awk 'BEGIN {printf "[%4.1s][%-4.1s][%c]\n", "😀xyz", "éxyz", 128512}'`, '[   😀][é   ][😀]\n'],
  [String.raw`awk 'BEGIN {print "\303\251", "\xf0\x9f\x98\x80"}'`, 'é 😀\n'],
  [String.raw`awk 'BEGIN {print "\357\273\277A", "\0x"}'`, '\uFEFFA \0x\n'],
  [String.raw`awk -v x='\303\251' 'BEGIN {print x, length(x)}'`, 'é 1\n'],
  [String.raw`awk 'END {print x, length(x)}' x='\xf0\x9f\x98\x80'`, '😀 1\n'],
  [String.raw`awk -F'\303\251' '{print NF, $2}' u`, '2 😀\n'],
  [String.raw`awk 'BEGIN {OFMT="val=%.2f!"; print 1.5; CONVFMT="str=%.2f!"; print 1.5 ""}'`, 'val=1.50!\nstr=1.50!\n'],
  [String.raw`awk 'BEGIN {OFMT="literal"; print 1.5; CONVFMT="literal"; print 1.5 ""}'`, 'literal\nliteral\n'],
  [String.raw`awk 'BEGIN {OFMT="%%%.2f%%"; print 1.5}'`, '%1.50%\n'],
  [String.raw`awk 'BEGIN {print ("😀" > ""), ("" < "😀"), ("é" == "é")}'`, '1 1 1\n'],
  [String.raw`awk 'BEGIN {print toupper("é"), tolower("É")}'`, 'É é\n'],
  [String.raw`awk 'BEGIN {print "a" ~ /[[.a.]]/, "a" ~ /[[=a=]]/}'`, '1 1\n'],
  [String.raw`LC_ALL=C awk '{print length, NF}' f`, '3 2\n3 2\n3 2\n3 2\n'],
  ['find . -type f,d | sort', '.\n./f\n./src\n./src/a.js\n./u\n'],
  ['find . ! -type f,d | sort', ''],
  ['sort -k2,1 f', 'a 1\na 1\nb 2\nx 0\n'],
  ['sort -uk2,1 f', 'b 2\n'],
  ['sort -rk2,1 f', 'x 0\nb 2\na 1\na 1\n'],
  ['sort -nk2,1 f', 'a 1\na 1\nb 2\nx 0\n'],
  ['cat <<< text', 'text\n'],
  [String.raw`awk 'BEGIN {print tolower("ΟΣ")}'`, 'οσ\n'],
]
for (const count of ['+2', '" 2"', '9007199254740993', '18446744073709551616', '9'.repeat(320)]) {
  const huge = count.length > 5
  SUPPORTED.push(
    ['grep -m' + count + ' a f', 'a 1\na 1\n'],
    ['grep -A' + count + ' b f', 'b 2\na 1\na 1\n' + (huge ? 'x 0\n' : '')],
    ['uniq -w' + count + ' f', 'b 2\na 1\nx 0\n'],
    ['uniq -s' + count + ' f', huge ? 'b 2\n' : 'b 2\na 1\nx 0\n'],
    ['uniq -f' + count + ' f', 'b 2\n'],
    ['xargs -n' + count + ' echo < f', huge ? 'b 2 a 1 a 1 x 0\n' : 'b 2\na 1\na 1\nx 0\n'],
  )
}

function virtual(command) {
  const r = createTerminal(FILES).run(command)
  assert.deepEqual(r.unsupported, [], command + ': refusing the command does not count as correct output')
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}
describe('re-audit correctness — permanent regressions', () => {
  for (const [command, stdout] of SUPPORTED) {
    it(command, () => {
      assert.deepEqual(virtual(command), { stdout, stderr: '', exitCode: 0 })
    })
  }
})
describe('re-audit correctness — strict GNU comparisons', { skip: missing.length ? 'Missing native tools: ' + missing.join(', ') : false }, () => {
  const dir = materialize(FILES)
  after(() => rmSync(dir, { recursive: true, force: true }))
  for (const [command, stdout] of SUPPORTED) {
    it(command, () => {
      const ref = native(command, dir)
      assert.deepEqual(ref, { stdout, stderr: '', exitCode: 0 }, 'the permanent expectation must match GNU')
      assert.deepEqual(virtual(command), ref)
    })
  }
  for (const value of ['é', '😀', 'a😀é', '']) {
    for (const format of ['%1s', '%5s', '%-5s', '%.0s', '%.1s', '%5.2s', '%c', '%4c']) {
      const command = `awk 'BEGIN {printf "[` + format + String.raw`]\n", "` + value + `"}'`
      it(command, () => assert.deepEqual(virtual(command), native(command, dir)))
    }
  }
})

