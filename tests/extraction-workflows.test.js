import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { f: 'one 1\ntwo 2\n', g: 'three 3\n', h: 'four 4\n' }
const FIELDS = '{ printf "%d", NF; for (i=1;i<=NF;i++) printf " [%s]", $i; print "" }'

function check(command, stdout, files = FILES, exitCode = 0) {
  const r = createTerminal(files).run(command)
  assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, '', exitCode, []], command)
}

function awk(prog, stdout, input = '', operands = '') {
  check(`awk -f prog ${operands} < input`, stdout, { ...FILES, prog, input })
}

function refused(prog, detail, input = '') {
  const t = createTerminal({ prog, input })
  const r = t.run('awk -f prog < input')
  assert.notEqual(r.exitCode, 0)
  assert.match(r.stderr, /not supported|execution limit/u)
  assert.ok(r.unsupported.some((gap) => gap.command === 'awk' && gap.detail === detail))
  assert.deepEqual(t.run('awk -f prog < input 2>/dev/null | cat').unsupported, r.unsupported)
}

describe('AWK extraction — remaining operands stay live', () => {
  const cases = [
    ['delete ARGV[2]', 'one 1\ntwo 2\n'],
    ['ARGV[2]="h"', 'one 1\ntwo 2\nfour 4\n'],
    ['ARGC=2', 'one 1\ntwo 2\n'],
    ['ARGV[ARGC++]="h"', 'one 1\ntwo 2\nthree 3\nfour 4\n'],
    ['ARGV[2]="x=7"', 'one 1\ntwo 2\n'],
  ]
  for (const [action, stdout] of cases) {
    it(action, () => awk(`NR==1 {${action}} {print}`, stdout, '', 'f g'))
  }
  for (const stage of ['BEGINFILE', 'ENDFILE']) {
    it(`${stage} can remove the next file`, () => {
      awk(`${stage} {if(FILENAME=="f") delete ARGV[2]} {print}`, 'one 1\ntwo 2\n', '', 'f g')
    })
  }
  it('ARGIND identifies file and assignment operands, including gaps', () => {
    awk('BEGIN { print ARGIND; delete ARGV[2] } BEGINFILE {print ARGIND,FILENAME} {print ARGIND,FNR} END {print ARGIND,x}', '0\n1 f\n1 1\n1 2\n3 h\n3 1\n4 7\n', '', 'f g h x=7')
    awk('NR==1 {ARGIND=8} {print ARGIND}', '8\n8\n2\n', '', 'f g')
    awk('BEGIN {print ARGIND} {print ARGIND, $0}', '0\n0 stdin\n', 'stdin\n')
  })
  it('a growing list of empty files cannot loop without a diagnostic', () => {
    refused('BEGIN {ARGV[1]="/dev/null";ARGC=2} BEGINFILE {ARGV[ARGC++]="/dev/null"}', 'execution limit')
  })
})

describe('AWK extraction — field boundaries preserve data', () => {
  const cases = [
    ['[^,]*', ',a,,b,\n', '5 [] [a] [] [b] []\n'],
    ['([^,]*)|("[^"]*")', 'a,"b,c",,d,\n', '5 [a] ["b,c"] [] [d] []\n'],
    ['a*', 'aba\nabc\n', '2 [a] [a]\n3 [a] [] []\n'],
    ['.*', 'abc\n\n', '1 [abc]\n0\n'],
    ['^|a', 'abc\n', '3 [a] [] []\n'],
    ['[^,]*', ',😀,,x,\n', '5 [] [😀] [] [x] []\n'],
    ['', '\n', '0\n'],
  ]
  for (const [pattern, input, stdout] of cases) {
    it(`FPAT=${JSON.stringify(pattern)} on ${JSON.stringify(input)}`, () => {
      awk(`BEGIN {FPAT=${JSON.stringify(pattern)}} ${FIELDS}`, stdout, input)
    })
  }
  for (const [widths, input, stdout] of [
    ['1 2 *', '😀ab\n', '2 [😀] [ab]\n'],
    ['1:1 1 *', '😀ab\n', '2 [a] [b]\n'],
    ['1:1 1 *', 'a\n', '1 []\n'],
    ['2:*', 'ab😀cd\n', '1 [😀cd]\n'],
    ['+1 +2 *', 'abcd\n', '3 [a] [bc] [d]\n'],
    ['', 'abc\n', '0\n'],
  ]) {
    it(`FIELDWIDTHS=${JSON.stringify(widths)} on ${JSON.stringify(input)}`, () => {
      awk(`BEGIN {FIELDWIDTHS=${JSON.stringify(widths)}} ${FIELDS}`, stdout, input)
    })
  }
  for (const widths of ['0 2', '2 0', '* 2', '1 rubbish', '0:2', '4294967296', '1:0', '1\n2']) {
    it(`validates the entire width specification on assignment: ${JSON.stringify(widths)}`, () => {
      const prog = `BEGIN {FIELDWIDTHS=${JSON.stringify(widths)}; print "bad"}`
      for (const command of ['awk -f prog', `awk -v FIELDWIDTHS='${widths}' 'BEGIN {print "bad"}'`]) {
        const r = createTerminal({ prog }).run(command)
        assert.equal(r.stdout, '')
        assert.equal(r.exitCode, 2)
        assert.match(r.stderr, /invalid FIELDWIDTHS/u)
        assert.deepEqual(r.unsupported, [])
      }
    })
  }
  for (const name of ['FS', 'RS', 'FPAT']) {
    it(`validates ${name} regexes before reading input`, () => {
      const r = createTerminal({}).run(`awk 'BEGIN {${name}="[x"; print "bad"}'`)
      assert.equal(r.stdout, '')
      assert.equal(r.exitCode, 2)
      assert.match(r.stderr, /invalid regex/u)
    })
  }
  it('paragraph mode adds newline separators only to single-character FS', () => {
    awk(`BEGIN {RS="";FS="[,:]"} ${FIELDS}`, '3 [a] [b\nc] [d]\n', 'a:b\nc,d\n\n')
    awk(`BEGIN {RS="";FS=":"} ${FIELDS}`, '4 [a] [b] [c] [d]\n', 'a:b\nc:d\n\n')
    refused('BEGIN {RS="";FS="^"} {print NF}', 'paragraph FS caret', 'a^b\n\n')
  })
})

describe('AWK extraction — replacement text and capture groups', () => {
  for (const fn of ['sub', 'gsub']) {
    for (const [replacement, expanded] of [
      ['\\\\', '\\\\'], ['\\\\q', '\\\\q'], ['\\&', '&'],
      ['\\\\&', '\\a'], ['\\\\\\&', '\\&'], ['\\\\\\\\', '\\\\'],
    ]) {
      it(`${fn} preserves replacement ${JSON.stringify(replacement)}`, () => {
        awk(`BEGIN {s="a"; print ${fn}(/a/,${JSON.stringify(replacement)},s),s}`, `1 ${expanded}\n`)
      })
    }
  }
  it('gensub handles escaped letters and only computes groups when needed', () => {
    awk('BEGIN {print gensub(/(a)/,"\\\\q","g","aba")}', 'qbq\n')
    awk('BEGIN {print gensub(/(a(b)?)+/,"[&]","g","aba")}', '[aba]\n')
    refused('BEGIN {print gensub(/a/,"x\\\\","g","a")}', 'gensub trailing backslash')
  })
  it('capture assertions retain their original subject and Unicode offsets', () => {
    awk('BEGIN {match("xab",/(\\Ba)(b)/,a); print a[1],a[1,"start"],a[2],a[2,"start"]}', 'a 2 b 3\n')
    awk('BEGIN {match("😀ab!",/(a|ab)/,a); print a[1],a[1,"start"],a[1,"length"]}', 'ab 2 2\n')
    awk('BEGIN {print gensub(/(\\Ba)(b)/,"\\\\2\\\\1","g","xab")}', 'xba\n')
    awk('BEGIN {match("a\\nb",/(a)(\\n)/,a); print a[1],a[2,"length"]}', 'a 1\n')
  })
  for (const pattern of ['(a(b)?)+', '(a*)*', '(a$)|(a)(b*)']) {
    it(`diagnoses capture semantics that differ from JS: ${pattern}`, () => {
      refused(`BEGIN {match("aba",/${pattern}/,a); print a[1]}`, 'regex capture semantics')
      refused(`BEGIN {print gensub(/${pattern}/,"\\\\1","g","aba")}`, 'regex capture semantics')
    })
  }
  it('named getline consumes shared input and keeps regular-file aliases independent', () => {
    for (const name of ['-', '/dev/stdin']) {
      check(`cat f | { awk 'BEGIN {getline x < "${name}";print x}'; cat; }`, 'one 1\n')
      check(`cat f | awk 'BEGIN {getline x < "${name}";print x} {print}'`, 'one 1\n')
    }
    check(`{ awk 'BEGIN {getline x < "-";print x}'; cat; } < f`, 'one 1\n')
    check(`{ awk 'BEGIN {getline x < "/dev/stdin";print x}'; cat; } < f`, 'one 1\none 1\ntwo 2\n')
  })
})

describe('grep extraction — combined modes and early exits', () => {
  const files = { f: 'y\nxx\ny\nxxx\n', g: 'none\n', binary: 'x\0\n' }
  it('only-matching inverted searches retain matching context and separators', () => {
    check('grep -ovn -A1 x f', '2-x\n2-x\n4-x\n4-x\n4-x\n', files)
    check('grep -ovn -C0 x f', '--\n', files)
    check('grep -ovn -m1 -C1 x f', '2-x\n2-x\n', files)
    check('grep -ov -C1 x f g', 'f-x\nf-x\nf-x\nf-x\nf-x\n--\n', files)
    check('grep -ov -C1 x g f', '--\nf-x\nf-x\nf-x\nf-x\nf-x\n', files)
  })
  it('quiet success preserves earlier errors and skips later operands', () => {
    const r = createTerminal(files).run('grep -q x missing f')
    assert.deepEqual([r.stdout, r.exitCode, r.unsupported], ['', 0, []])
    assert.match(r.stderr, /missing: no such file/u)
    check('grep -q x f missing', '', files)
    check('grep -q x f binary', '', files)
  })
  it('zero match limits avoid reads, while -L still lists readable files', () => {
    for (const flags of ['', '-q', '-l', '-c', '-qL']) check(`grep ${flags} -m0 x missing`, '', files, 1)
    check('grep -L -m0 x f g binary', 'f\ng\nbinary\n', files, 1)
    check('{ grep -m0 x; cat; } < f', files.f, files)
    check('{ grep -Lm0 x; cat; } < f', '(standard input)\n' + files.f, files)
  })
})
