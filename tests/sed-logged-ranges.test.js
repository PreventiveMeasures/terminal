import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

function check(command, input, stdout) {
  const result = createTerminal({ input }).run(`cat input | ${command}`)
  assert.deepEqual(result, { stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] }, command)
}

const REGEX_RANGES = [
  ["'/a.a.a = f a/,/^};/p'", 'aXaYa = f a', '};'],
  ["'/^  o(/,/^  }/p'", '  o(value) {', '  }'],
  ["'/^c m/,/^};/p'", 'c m = {', '};'],
  ["'/^e f verify/,/^}/p'", 'e f verify(value) {', '}'],
  [String.raw`'/^f a/,/^  \/\//p'`, 'f a() {', '  // next section'],
  ["'/^f a/,/^}/p'", 'f a() {', '}'],
  ["'/a/,/^};/p'", 'a = {', '};'],
  ["'/c a =/,/^};/p'", 'c a = {', '};'],
  ["'/a(a, a, a, a/,/^    }/p'", 'a(a, a, a, a) {', '    }'],
  ["'/a (/,/^  }/p'", 'a (value) {', '  }'],
  ["'/f x/,/^c y/p'", 'f x() {', 'c y = 0'],
  ["'/f x/,/^}/p'", 'f x() {', '}'],
  [String.raw`'/s() {/,/^[0-9]*-\s*}/p'`, 's() {', '12-\t }'],
  ["'/s = (a, b/,/^}/p'", 's = (a, b) => {', '}'],
  ["'/s s s/,/^  }/p'", 's s s {', '  }'],
  ["'/s/,/^    }/p'", 's() {', '    }'],
  ["'/s(s/,/^  }/p'", 's(something) {', '  }'],
  ["'/t <w T = v>/,/^  }/p'", 't <w T = v> {', '  }'],
  ["'/var a/,/^};/p'", 'var a = {', '};'],
  ["'/a = /,/^}/p'", 'a = {', '}'],
]

const RELATIVE_RANGES = [
  ["'/^c a = (a, a)/,+40p'", 'c a = (a, a) => {', 40],
  ["'/c a = /,+30p'", 'c a = {', 30],
  ["'/e a f g/,+30p'", 'e a f g() {', 30],
  ["'/s s/,+12p'", 's s {', 12],
  ["'/t <w T>$/,+12p'", 't <w T>', 12],
  ["'/t <w T>/,+30p'", 't <w T> {', 30],
  ['/"a b"/,+25p', 'a b', 25],
]

describe('sed — logged source range commands', () => {
  for (const [script, start, end] of REGEX_RANGES) {
    it(`supports sed -n ${script}`, () => {
      check(`sed -n ${script}`, `000\n${start}\n111\n${end}\n999\n`, `${start}\n111\n${end}\n`)
    })
  }

  for (const [script, start, count] of RELATIVE_RANGES) {
    it(`supports sed -n ${script} with an inclusive relative endpoint`, () => {
      const body = Array.from({ length: count }, (_, i) => `line ${i + 1}\n`).join('')
      check(`sed -n ${script}`, `000\n${start}\n${body}999\n`, `${start}\n${body}`)
    })
  }

  for (const [script, start, end] of [
    ["'1,20p'", 1, 20], ["'40,60p'", 40, 60], ['88,102p', 88, 102],
    ["'1,60p'", 1, 60], ['1,60p', 1, 60], ['1,80p', 1, 80],
    ['200,400p', 200, 400], ['1,20p', 1, 20], ['1,40p', 1, 40],
  ]) {
    it(`supports sed -n ${script}`, () => {
      const input = Array.from({ length: 410 }, (_, i) => `record ${i + 1}\n`).join('')
      const stdout = Array.from({ length: end - start + 1 }, (_, i) => `record ${start + i}\n`).join('')
      check(`sed -n ${script}`, input, stdout)
    })
  }

  it('supports a regex start through the final record', () => {
    check('sed -n \'/"a"/,$p\'', 'before\n"a"\nbody\nlast', '"a"\nbody\nlast')
  })

  it('supports sed -n \'1,1p\' with output discarded', () => {
    check("sed -n '1,1p' >/dev/null", 'one\ntwo\n', '')
  })

  it('keeps numeric and regex ranges independent in a joined script', () => {
    const lines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`)
    lines[1] = '_(one'
    lines[3] = '-- one'
    lines[17] = '_(two'
    lines[21] = '-- two'
    const printed = [1, 2, 2, 3, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 18, 19, 19, 20, 20, 21, 22]
    check("sed -n '1,20p;/_(/,/^--/p'", lines.join('\n') + '\n', printed.map((n) => lines[n - 1] + '\n').join(''))
  })
})

describe('sed — range selection semantics', () => {
  it('checks a regex endpoint only after the starting record', () => {
    check("sed -n '/start/,/end/p'", 'start end\nmiddle\nend\noutside\n', 'start end\nmiddle\nend\n')
  })

  it('reactivates a regex range after it closes, without restarting on its endpoint', () => {
    check("sed -n '/start/,/end/p'", 'start\nstart end\nignored\nstart again\ninside\nend\nignored\n',
      'start\nstart end\nstart again\ninside\nend\n')
  })

  it('allows one-record relative ranges and restarts them on later matches', () => {
    check("sed -n '/start/,+0p'", 'start\nignored\nstart again\nignored\n', 'start\nstart again\n')
  })

  it('does not extend a relative range when another start occurs inside it', () => {
    check("sed -n '/start/,+2p'", 'start\nstart inside\nend\nignored\nstart again\nlast',
      'start\nstart inside\nend\nstart again\nlast')
  })

  it('prints through EOF when no endpoint matches', () => {
    check("sed -n '/start/,/end/p'", 'ignored\nstart\nmiddle\nlast', 'start\nmiddle\nlast')
  })

  it('lets separate regex ranges overlap and print their shared records twice', () => {
    check("sed -n '/^a/,/^c/p;/^b/,/^d/p'", 'a\nb\nc\nd\ne\n', 'a\nb\nb\nc\nc\nd\n')
  })

  it('matches address regexes against pattern space after earlier substitutions', () => {
    check("sed -n 's/old/start/;/start/,/end/p'", 'ignored\nold\nbody\nend\nignored\n', 'start\nbody\nend\n')
  })

  it('retains default printing alongside explicitly addressed print commands', () => {
    check("sed '/start/,/end/p'", 'ignored\nstart\nend\nlast', 'ignored\nstart\nstart\nend\nend\nlast')
  })

  it('uses cumulative lines and the last nonempty input record for $ across files', () => {
    const terminal = createTerminal({ first: 'one\nstart', second: 'three\nfour', empty: '' })
    for (const [script, stdout] of [["'2,3p'", 'start\nthree\n'], ["'/start/,$p'", 'start\nthree\nfour'], ["'$p'", 'four']]) {
      assert.deepEqual(terminal.run(`sed -n ${script} first empty second empty`), {
        stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [],
      })
    }
  })

  it('preserves missing terminators when multiple addressed commands print the final record', () => {
    check("sed -n '/start/,$p;$p'", 'ignored\nstart\nlast', 'start\nlast\nlast')
  })

  it('matches nothing on empty input or when a start address is absent', () => {
    check("sed -n '/start/,/end/p'", '', '')
    check("sed -n '/start/,+40p'", 'one\ntwo\n', '')
  })
})
