import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU sed execute.c: replaced is reset when t branches, when T falls through,
// and whenever read_pattern_space obtains the next input record.
const FILES = {
  input: 'aaab\nnone\naab\n', single: 'ab\n', repeated: 'a\na\n',
  unterminated: 'ab', empty: '', range: 'x\n',
  'scripts/label': ':target\ns/a/A/\n',
}
const quote = (text) => "'" + text.replaceAll("'", "'\\''") + "'"
const sed = (script, input = 'single', flags = '') => `sed ${flags} ${quote(script)} ${input}`

function examples(rows) {
  for (const [name, command, stdout] of rows) {
    it(name, () => {
      assert.deepEqual(createTerminal(FILES).run(command), { stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] }, command)
    })
  }
}

describe('sed labels and unconditional branches', () => {
  examples([
    ['forward branch skips intervening commands', sed('b end;s/.*/BAD/;:end'), 'ab\n'],
    ['a bare branch ends the cycle with automatic output', sed('b;s/.*/BAD/'), 'ab\n'],
    ['a bare branch keeps quiet output quiet', sed('b;p', 'single', '-n'), ''],
    ['a branch preserves the missing record terminator', sed('b', 'unterminated'), 'ab'],
    ['a label alone leaves input unchanged', sed(':label', 'input'), FILES.input],
    ['an addressed branch skips only selected records', sed('2b end;s/^/>/;:end', 'input'), '>aaab\nnone\n>aab\n'],
    ['an inverted branch follows selection', sed('/none/!b end;s/^/>/;:end', 'input'), 'aaab\n>none\naab\n'],
    ['a branch can leave nested blocks', sed('1{{b end;s/.*/BAD/;};};s/.*/BAD/;:end'), 'ab\n'],
    ['a branch into a block bypasses its opening address', sed('b inside;20{:inside;s/a/A/;}'), 'Ab\n'],
    ['duplicate labels resolve to the last definition', sed('b x;:x;s/.*/BAD/;:x;s/a/A/'), 'Ab\n'],
    ['labels resolve across expressions', "sed -e 'b target' -e 's/.*/BAD/' -e ':target;s/a/A/' single", 'Ab\n'],
    ['labels resolve across script files', "sed -e 'b target' -e 's/.*/BAD/' -f scripts/label single", 'Ab\n'],
    ['a branch flushes queued append text at cycle end', "sed -e 'a tail' -e 'b' -e 's/.*/BAD/' single", 'ab\ntail\n'],
    ['quiet branch still flushes queued append text', "sed -n -e 'a tail' -e 'b' -e p single", 'tail\n'],
  ])
})

describe('sed conditional branches use substitution state', () => {
  examples([
    ['a backward t loop reduces repeated matches', sed(':again;s/aa/a/;t again', 'input'), 'ab\nnone\nab\n'],
    ['a successful substitution to identical text sets the flag', sed('s/a/a/;t hit;s/.*/BAD/;:hit'), 'ab\n'],
    ['a later failed substitution does not erase a success', sed('s/a/A/;s/z/Z/;t hit;s/.*/MISS/;:hit', 'input'), 'Aaab\nMISS\nAab\n'],
    ['a taken t clears the flag', sed('s/a/A/;t one;:one;t two;s/.*/CLEAR/;b end;:two;s/.*/BAD/;:end'), 'CLEAR\n'],
    ['T clears the flag when it falls through', sed('s/a/A/;T no;t bad;s/.*/CLEAR/;b end;:no;s/.*/NO/;b end;:bad;s/.*/BAD/;:end'), 'CLEAR\n'],
    ['T branches without a successful substitution', sed('T end;s/.*/BAD/;:end'), 'ab\n'],
    ['b preserves substitution success', sed('s/a/A/;b mid;:mid;t end;s/.*/BAD/;:end'), 'Ab\n'],
    ['unselected t leaves the flag intact', sed('s/a/A/;2t bad;t end;:bad;s/.*/BAD/;:end'), 'Ab\n'],
    ['each new cycle clears earlier success', sed('1s/a/A/;t changed;s/^/no:/;b end;:changed;s/^/yes:/;:end', 'repeated'), 'yes:A\nno:a\n'],
    ['bare t ends only successful cycles', sed('s/a/A/;t;s/^/none:/', 'input'), 'Aaab\nnone:none\nAab\n'],
    ['bare T ends only unsuccessful cycles', sed('s/a/A/;T;s/^/hit:/', 'input'), 'hit:Aaab\nnone\nhit:Aab\n'],
    ['t can control a finite loop with numeric occurrences', sed(':again;s/a/A/2;t again', 'input'), 'aAAb\nnone\naAb\n'],
    ['n resets success before a later t', sed('s/a/A/;n;t bad;p;b end;:bad;s/.*/BAD/;p;:end', 'repeated', '-n'), 'a\n'],
    ['N resets success before a later t', sed('s/a/A/;N;t bad;p;b end;:bad;s/.*/BAD/;p;:end', 'repeated', '-n'), 'A\na\n'],
    ['new substitutions after N can set the flag again', sed('N;s/a/A/;t hit;s/.*/BAD/;:hit', 'repeated'), 'A\na\n'],
    ['a +0 range closes on its first visit to the same line', sed(':x;1,+0s/x/xx/;t x', 'range'), 'xx\n'],
    ['a regex-ended range can close on its second visit to the same line', sed(':x;1,/x/s/x/xx/;t x', 'range'), 'xxx\n'],
    ['a numeric single-line range closes on its first visit', sed(':x;1,1s/x/xx/;t x', 'range'), 'xx\n'],
  ])
})

describe('sed branch errors and execution limits reach the right channel', () => {
  for (const script of ['b missing', 't missing', 'T missing', '20b missing', 'q;b missing']) {
    it(`rejects unresolved labels before reading input: ${script}`, () => {
      const r = createTerminal(FILES).run(sed(script, 'empty'))
      assert.equal(r.stdout, '')
      assert.equal(r.exitCode, 4)
      assert.match(r.stderr, /label/u)
      assert.deepEqual(r.unsupported, [])
    })
  }

  for (const script of [':', ':   ', '1:label', '1,2:label']) {
    it(`reports ordinary syntax errors for ${JSON.stringify(script)}`, () => {
      const r = createTerminal(FILES).run(sed(script))
      assert.equal(r.stdout, '')
      assert.equal(r.exitCode, 1)
      assert.notEqual(r.stderr, '')
      assert.deepEqual(r.unsupported, [])
    })
  }

  for (const script of [':loop;b loop', ':loop;s/a/a/;t loop']) {
    it(`diagnoses an execution limit instead of hanging: ${script}`, () => {
      const r = createTerminal(FILES).run(sed(script))
      assert.equal(r.stdout, '')
      assert.notEqual(r.exitCode, 0)
      assert.match(r.stderr, /limit|budget/u)
      assert.ok(r.unsupported.length > 0)
    })
  }

  it('preserves the execution-limit diagnostic through stderr suppression and a pipe', () => {
    const r = createTerminal(FILES).run(sed(':loop;b loop') + ' 2>/dev/null | cat')
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.ok(r.unsupported.length > 0)
  })

  it('does not execute a backward branch with no input cycle', () => {
    assert.deepEqual(createTerminal(FILES).run(sed(':loop;b loop', 'empty')), {
      stdout: '', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
  })
})
