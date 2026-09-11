import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { binary: 'hit\0tail\n', good: 'hit\n', miss: 'other\n', empty: '' }
const BINARY_STDIN = 'grep: skipped binary standard input. Binary input is treated as text with -a.'
const expected = (stdout = '', notes = [], extra = {}) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes, ...extra })

function binaryNote(paths) {
  const listed = paths.length < 10 ? ': ' + paths.map((path) => JSON.stringify(path)).join(', ') : ''
  return `grep: skipped ${paths.length} binary ${paths.length === 1 ? 'file' : 'files'}${listed}. Binary input is treated as text with -a.`
}

function excludedNote(paths) {
  const listed = paths.length < 10 ? ': ' + paths.map((path) => JSON.stringify(path)).join(', ') : ''
  return `grep: excluded ${paths.length} ${paths.length === 1 ? 'entry' : 'entries'} by --include/--exclude/--exclude-dir rules${listed}.`
}

describe('grep notes identify actual binary input skips', () => {
  for (const [command, stdout, exitCode] of [
    ['grep -I hit binary good', 'good:hit\n', 0],
    ['grep -I absent binary', '', 1],
    ['grep -Ic hit binary', '0\n', 1],
    ['grep -IL hit binary', 'binary\n', 1],
    ['grep -Iq hit binary good missing', '', 0],
    ['grep -aI hit binary', '', 1],
    ['grep --text -I hit binary', '', 1],
  ]) {
    it(command, () => {
      assert.deepEqual(createTerminal(FILES).run(command), expected(stdout, [binaryNote(['/binary'])], { exitCode }))
    })
  }

  for (const command of ['grep -a hit binary', 'grep -Ia hit binary', 'grep -I --text hit binary']) {
    it('does not claim a binary omission when text mode wins: ' + command, () => {
      assert.deepEqual(createTerminal(FILES).run(command), expected('hit\0tail\n'))
    })
  }

  for (const command of ['grep -I hit good', 'grep -Iq hit good binary', 'grep -Im0 hit binary', 'grep -ILm0 hit binary']) {
    it('does not report binary input which was not skipped: ' + command, () => {
      const result = createTerminal(FILES).run(command)
      assert.deepEqual(result.notes, [])
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('keeps unsupported default binary handling in the diagnostic channel', () => {
    const result = createTerminal(FILES).run('grep hit binary 2>/dev/null | true')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [])
    assert.ok(result.unsupported.some(({ detail }) => detail === 'binary input'))
  })

  for (const command of [
    'cat binary | grep -I hit',
    'cat binary | grep -I hit - -',
    'cat binary | grep -I hit /dev/stdin',
    'grep -I hit <binary',
  ]) {
    it('describes binary standard input: ' + command, () => {
      assert.deepEqual(createTerminal(FILES).run(command), expected('', [BINARY_STDIN], { exitCode: 1 }))
    })
  }

  it('attributes redirected writable input to its known absolute path', () => {
    const terminal = createTerminal({}, { mount: '/repo', writable: '/tmp/' })
    const result = terminal.run("printf 'hit\\0tail\\n' >/tmp/binary; grep -I hit </tmp/binary")
    assert.deepEqual(result, expected('', [binaryNote(['/tmp/binary'])], { exitCode: 1 }))
  })

  it('deduplicates actual file aliases and retains normal count output', () => {
    const result = createTerminal(FILES).run('grep -Ic hit binary ./binary /binary')
    assert.deepEqual(result, expected('binary:0\n./binary:0\n/binary:0\n', [binaryNote(['/binary'])], { exitCode: 1 }))
  })

  it('retains earlier skipped inputs when later binary detection is unsupported', () => {
    const terminal = createTerminal({ ...FILES, late: 'hit\n' + 'x'.repeat(96 * 1024) + '\0' })
    const result = terminal.run('grep -I hit binary late 2>/dev/null | true')
    assert.deepEqual(result.notes, [binaryNote(['/binary'])])
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.ok(result.unsupported.some(({ detail }) => detail === 'late binary detection'))
  })
})

describe('grep notes identify entries omitted by filename and directory filters', () => {
  const sources = { 'dir/a.ts': 'hit\n', 'dir/b.js': 'hit\n', 'dir/vendor/deep/c.ts': 'hit\n', 'dir/vendor/nested/d.js': 'hit\n' }

  for (const filters of ['--include="*.ts"', '--exclude="*.js"']) {
    it('collects file and directory omissions together: ' + filters, () => {
      const result = createTerminal(sources).run('grep -r hit dir ' + filters + ' --exclude-dir=vendor')
      assert.deepEqual(result, expected('dir/a.ts:hit\n', [excludedNote(['/dir/b.js', '/dir/vendor'])]))
    })
  }

  it('counts only the first excluded ancestor without its unvisited descendants', () => {
    const result = createTerminal(sources).run('grep -r hit dir --exclude-dir=vendor --exclude-dir=nested')
    assert.deepEqual(result, expected('dir/a.ts:hit\ndir/b.js:hit\n', [excludedNote(['/dir/vendor'])]))
  })

  it('reports empty directories actually excluded during recursion', () => {
    const result = createTerminal({}, { mount: '/empty' }).run('grep -r hit / --exclude-dir=empty')
    assert.deepEqual(result, expected('', [excludedNote(['/empty'])], { exitCode: 1 }))
  })

  it('preserves named start-directory trailing-slash matching rules', () => {
    const terminal = createTerminal(sources)
    assert.deepEqual(terminal.run('grep -r hit dir/vendor --exclude-dir=vendor'), expected('', [excludedNote(['/dir/vendor'])], { exitCode: 1 }))
    assert.deepEqual(terminal.run('grep -rh hit dir/vendor/ --exclude-dir=vendor'), expected('hit\nhit\n'))
  })

  it('does not apply directory filters to file operands or their parent directories', () => {
    const result = createTerminal(sources).run('grep -r hit dir/vendor/deep/c.ts --exclude-dir=vendor --exclude-dir=c.ts')
    assert.deepEqual(result, expected('hit\n'))
  })

  it('includes explicit operands in file-filter notes and deduplicates path spellings', () => {
    const result = createTerminal(sources).run('grep hit dir/b.js ./dir/b.js /dir/b.js --include="*.ts"')
    assert.deepEqual(result, expected('', [excludedNote(['/dir/b.js'])], { exitCode: 1 }))
  })

  it('honors the final matching include/exclude rule without claiming overridden skips', () => {
    const result = createTerminal({ 'a.ts': 'hit\n', 'b.js': 'hit\n', 'c.txt': 'hit\n' })
      .run('grep -rh hit . --include="*" --exclude="*.ts" --include=a.ts --exclude="*.js"')
    assert.deepEqual(result, expected('hit\nhit\n', [excludedNote(['/b.js'])]))
  })

  it('does not report filters which exclude no entries', () => {
    const result = createTerminal(sources).run('grep -rh hit dir --include="*" --exclude="*.missing" --exclude-dir=missing')
    assert.deepEqual(result, expected('hit\nhit\nhit\nhit\n'))
  })

  it('does not count nonexistent operands or unnamed stdin as filename exclusions', () => {
    const result = createTerminal(FILES).run('cat good | grep hit - missing --include="*.ts"')
    assert.deepEqual(result, expected('(standard input):hit\n', [], { stderr: 'grep: missing: no such file or directory\n', exitCode: 2 }))
  })

  it('counts binary files excluded by name only in the rule category', () => {
    const result = createTerminal({ 'bad.bin': 'hit\0\n', 'good.txt': 'hit\n' }).run('grep -rIh hit . --include="*.txt"')
    assert.deepEqual(result, expected('hit\n', [excludedNote(['/bad.bin'])]))
  })

  it('keeps binary and rule omissions as separate explanations', () => {
    const result = createTerminal({ 'bad.txt': 'hit\0\n', 'skip.js': 'hit\n', 'good.txt': 'hit\n' }).run('grep -rIh hit . --include="*.txt"')
    assert.deepEqual(result, expected('hit\n', [binaryNote(['/bad.txt']), excludedNote(['/skip.js'])]))
  })

  it('reports earlier exclusions but not later unvisited operands after quiet success', () => {
    const result = createTerminal({ 'a.js': 'hit\n', 'b.ts': 'hit\n', 'c.js': 'hit\n' }).run('grep -q hit a.js b.ts c.js --include="*.ts"')
    assert.deepEqual(result, expected('', [excludedNote(['/a.js'])]))
  })

  it('retains earlier filename omissions when a later filename is unsupported', () => {
    const result = createTerminal({ 'a.skip': 'hit\n', é: 'hit\n' }).run('grep -r hit . --include="[a-z]" 2>/dev/null | true')
    assert.deepEqual(result.notes, [excludedNote(['/a.skip'])])
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.ok(result.unsupported.length > 0)
  })
})

describe('grep omission notes retain bounded paths and run scope', () => {
  for (const count of [9, 10]) {
    for (const binary of [true, false]) {
      it('formats ' + count + ' omitted ' + (binary ? 'binary files' : 'filtered entries'), () => {
        const paths = Array.from({ length: count }, (_, i) => '/file' + i)
        const files = Object.fromEntries(paths.map((path) => [path, binary ? 'hit\0\n' : 'hit\n']))
        const command = binary ? 'grep -rI hit .' : 'grep -r hit . --exclude="*"'
        assert.deepEqual(createTerminal(files).run(command), expected('', [binary ? binaryNote(paths) : excludedNote(paths)], { exitCode: 1 }))
      })
    }
  }

  it('quotes paths and sorts them by code point independently of operand order', () => {
    const paths = ['/line\nbreak', '/quote"', '/slash\\', '/\uE000', '/😀']
    const result = createTerminal(Object.fromEntries(paths.toReversed().map((path) => [path, 'hit\0\n']))).run('grep -rI hit .')
    assert.deepEqual(result, expected('', [binaryNote(paths)], { exitCode: 1 }))
  })

  it('uses mounted absolute paths while preserving relative output spelling', () => {
    const terminal = createTerminal({ 'dir/bad': 'hit\0\n', 'dir/good': 'hit\n' }, { mount: '/work [x]', cwd: '/work [x]/dir' })
    assert.deepEqual(terminal.run('grep -I hit bad good'), expected('good:hit\n', [binaryNote(['/work [x]/dir/bad'])], { cwd: '/work [x]/dir' }))
  })

  for (const [command, stdout] of [
    ['grep -I hit binary good 2>/dev/null | cat', 'good:hit\n'],
    ['grep -I hit binary >/dev/null', ''],
    ['(grep -I hit binary)', ''],
    ['value=$(grep -I hit binary); true', ''],
    ['find binary -exec grep -I hit {} \\;', ''],
    ["printf '%s\\n' binary | xargs grep -I hit", ''],
    ['for path in binary binary; do grep -I hit "$path"; done', ''],
  ]) {
    it('retains notes through nested execution: ' + command, () => {
      const result = createTerminal(FILES).run(command)
      assert.deepEqual(result.notes, [binaryNote(['/binary'])])
      assert.equal(result.stdout, stdout)
      assert.equal(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('preserves normal errors and notes despite hidden stderr', () => {
    const terminal = createTerminal(FILES)
    assert.deepEqual(terminal.run('grep -I hit binary missing'), expected('', [binaryNote(['/binary'])], {
      stderr: 'grep: missing: no such file or directory\n', exitCode: 2,
    }))
    // The unreadable operand is only on the notes channel now that its own
    // diagnostic went to /dev/null.
    assert.deepEqual(terminal.run('grep -I hit binary missing 2>/dev/null | true'),
      expected('', [binaryNote(['/binary']), "stderr: a redirect discarded \"grep: missing: no such file or directory\". Nothing else in this run reports that path."]))
  })

  it('deduplicates messages per run and keeps later runs independent', () => {
    const terminal = createTerminal(FILES)
    const first = terminal.run('grep -I hit binary; grep -I hit binary')
    assert.deepEqual(first.notes, [binaryNote(['/binary'])])
    assert.ok(Object.isFrozen(first.notes))
    assert.deepEqual(terminal.run('grep hit good'), expected('hit\n'))
    assert.deepEqual(first.notes, [binaryNote(['/binary'])])
  })
})
