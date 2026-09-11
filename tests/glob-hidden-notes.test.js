import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = { '.hidden': '', visible: '' }
const expected = (stdout = '', notes = [], extra = {}) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', notes, unsupported: [], ...extra })

function omission(pattern, paths) {
  const entries = paths.length === 1 ? 'entry' : 'entries'
  const list = paths.length < 10 ? ': ' + paths.map((path) => JSON.stringify(path)).join(', ') : ''
  return `glob: omitted ${paths.length} hidden ${entries} while expanding ${JSON.stringify(pattern)}${list}.`
}

const unmatched = (pattern) => `glob: no paths matched ${JSON.stringify(pattern)}; the pattern was left literal.`

const STAR_NOTE = omission('*', ['/.hidden'])

describe('pathname glob notes describe the dotfile gate', () => {
  it('keeps normal expansion output and adds a separate note', () => {
    assert.deepEqual(createTerminal(FILES).run('printf "%s\\n" *'), expected('visible\n', [STAR_NOTE]))
  })

  it('counts only the excluded candidates the pattern would have taken', () => {
    // `.env` and `.cache` are hidden, but `*.ts` would have passed over them
    // anyway; saying they were omitted would describe a gate that did nothing.
    const sources = { '.env': '', '.cache/config': '', 'main.ts': '', other: '' }
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" *.ts'), expected('main.ts\n'))
  })

  it('counts a hidden candidate the pattern would have taken', () => {
    const sources = { '.bar': '', '.hidden.bar': '', '.foo.txt': '', 'visible.bar': '' }
    const note = omission('*.bar', ['/.bar', '/.hidden.bar'])
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" *.bar'), expected('visible.bar\n', [note]))
  })

  it('says nothing when every hidden name fails the pattern', () => {
    const sources = { '.foo.txt': '', 'visible.bar': '' }
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" *.bar'), expected('visible.bar\n'))
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" *.nope'), expected('*.nope\n', [unmatched('*.nope')]))
  })

  it('says nothing about a hidden directory the pattern would have found nothing in', () => {
    // `*` would have entered `.hidden`, but there is no `.hidden/x` to find,
    // so the gate cost this caller nothing and has nothing to report.
    const sources = { '.file': '', '.hidden/child': '', 'visible/x': '' }
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" */x'), expected('visible/x\n'))
  })

  it('counts an intermediate directory a later segment would have matched in', () => {
    const sources = { '.file': '', '.hidden/x': '', 'visible/x': '' }
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" */x'), expected('visible/x\n', [omission('*/x', ['/.hidden'])]))
  })

  it('deduplicates a revisited directory while allowing its newly eligible files', () => {
    const sources = { '.dir/child': '', '.file': '', 'visible/file': '' }
    const note = omission('*/../*', ['/.dir', '/.file'])
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" */../*'), expected('visible/../visible\n', [note]))
  })

  it('aggregates exclusions from every traversed segment, hidden descendants included', () => {
    // Reaching `.hidden/.unvisited` took two gated names, and both are named:
    // adding a leading dot to only one of the two segments still finds nothing.
    const sources = { '.hidden/.unvisited': '', 'a/.local': '', 'a/x': '', 'b/.dir/deeper': '', 'b/x': '' }
    const note = omission('*/*', ['/.hidden', '/.hidden/.unvisited', '/a/.local', '/b/.dir'])
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" */*'), expected('a/x\nb/x\n', [note]))
  })

  it('keeps a note when visible candidates fail to match', () => {
    const sources = { '.hidden.ts': '', visible: '' }
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" *.ts'), expected('*.ts\n', [omission('*.ts', ['/.hidden.ts']), unmatched('*.ts')]))
  })

  it('does not enumerate absent literal parent directories', () => {
    assert.deepEqual(createTerminal(FILES).run('printf "%s\\n" missing/*'), expected('missing/*\n', [unmatched('missing/*')]))
  })

  it('does not invent omissions for an empty directory', () => {
    assert.deepEqual(createTerminal({}).run('printf "%s\\n" *'), expected('*\n', [unmatched('*')]))
  })

  for (const count of [9, 10]) {
    it('formats the ' + count + '-entry threshold', () => {
      const paths = Array.from({ length: count }, (_, index) => '/.hidden' + index)
      const sources = Object.fromEntries(paths.map((path) => [path, '']))
      assert.deepEqual(createTerminal(sources).run('printf "%s\\n" *'), expected('*\n', [omission('*', paths), unmatched('*')]))
    })
  }

  it('quotes special characters and sorts paths by Unicode code point', () => {
    const names = ['.😀', '.\uE000', '.line\nbreak', '.quote"', '.slash\\']
    const paths = ['/.line\nbreak', '/.quote"', '/.slash\\', '/.\uE000', '/.😀']
    const sources = Object.fromEntries(names.map((name) => [name, '']))
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" *'), expected('*\n', [omission('*', paths), unmatched('*')]))
  })
})

describe('literal and explicitly dot-prefixed words avoid omission notes', () => {
  for (const [command, stdout] of [
    ["printf '%s\\n' '*'", '*\n'],
    ['printf "%s\\n" "*"', '*\n'],
    ['printf "%s\\n" \\*', '*\n'],
    ['printf "%s\\n" .*', '.hidden\n'],
    ['printf "%s\\n" \\.*', '.hidden\n'],
    ['pattern="*"; printf "%s\\n" "$pattern"', '*\n'],
  ]) {
    it(command, () => assert.deepEqual(createTerminal(FILES).run(command), expected(stdout)))
  }

  it('still excludes hidden names when a bracket expression merely matches a dot', () => {
    assert.deepEqual(createTerminal(FILES).run('printf "%s\\n" [.]*'), expected('[.]*\n', [omission('[.]*', ['/.hidden']), unmatched('[.]*')]))
  })

  it('applies the dotfile rule separately at each path segment', () => {
    const sources = { '.dir/.nested': '', '.dir/visible': '', '.file': '' }
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" .*/*'), expected('.dir/visible\n', [omission('.*/*', ['/.dir/.nested'])]))
  })

  it('does not attribute omissions to quoted metacharacters in literal parent segments', () => {
    const sources = { '.root': '', '*/.child': '', '*/visible': '' }
    const note = omission('\\*/*', ['/*/.child'])
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" "*"/*'), expected('*/visible\n', [note]))
  })

  it('does not expose hidden Unicode names to a locale-sensitive matcher while collecting notes', () => {
    const sources = { '.café': '', '.😀/child': '', file: '' }
    const note = omission('?*', ['/.café', '/.😀'])
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" ?*'), expected('file\n', [note]))
  })

  it('does not test hidden Unicode directories in an intermediate segment', () => {
    const sources = { '.😀/child': '', 'visible/file': '' }
    const note = omission('?*/*', ['/.😀'])
    assert.deepEqual(createTerminal(sources).run('printf "%s\\n" ?*/*'), expected('visible/file\n', [note]))
  })
})

describe('pathname notes are separate from command-specific pattern matching', () => {
  const sources = { '.hidden.ts': 'X\n', 'visible.ts': 'X\n' }
  for (const command of [
    'find . -name "*.ts"',
    'find . -path "*/*.ts"',
    'grep -r X . --include="*.ts"',
    '[[ visible.ts == *.ts ]]',
    'value=visible.ts; printf "%s" "${value#*i}"',
    'value=visible.ts; printf "%s" "${value//*/X}"',
    "printf '%s' '*' | xargs printf '%s\\n'",
  ]) {
    it(command, () => {
      const result = createTerminal(sources).run(command)
      assert.equal(result.exitCode, 0)
      assert.equal(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
      assert.deepEqual(result.notes, [])
    })
  }
})

describe('pathname notes survive shell execution and remain scoped per run', () => {
  for (const [command, stdout] of [
    ['printf "%s\\n" * >/dev/null', ''],
    ['printf "%s\\n" * 2>/dev/null | true', ''],
    ['(printf "%s\\n" *)', 'visible\n'],
    ['{ printf "%s\\n" *; } >/dev/null', ''],
    ['value=$(printf "%s\\n" *); printf "%s" "$value"', 'visible'],
    ['for value in *; do printf "%s\\n" "$value"; done', 'visible\n'],
    ['pattern="*"; printf "%s\\n" $pattern', 'visible\n'],
    ['printf "%s\\n" * *', 'visible\nvisible\n'],
  ]) {
    it(command, () => assert.deepEqual(createTerminal(FILES).run(command), expected(stdout, [STAR_NOTE])))
  }

  it('keeps separate messages for different expanded words in encounter order', () => {
    assert.deepEqual(createTerminal(FILES).run('printf "%s\\n" ./* * ./*'), expected('./visible\nvisible\n./visible\n', [omission('./*', ['/.hidden']), STAR_NOTE]))
  })

  it('aggregates each brace-expanded word independently', () => {
    const sources = { '.env.ts': '', '.env.js': '', 'a.js': '', 'b.ts': '' }
    const result = createTerminal(sources).run('printf "%s\\n" {*.ts,*.js}')
    assert.deepEqual(result, expected('b.ts\na.js\n', [omission('*.ts', ['/.env.ts']), omission('*.js', ['/.env.js'])]))
  })

  it('retains completed omissions if a later visible candidate triggers an unsupported matcher error', () => {
    const terminal = createTerminal({ '.hidden/file': '', 'café': '' })
    const result = terminal.run('{ printf "%s\\n" ?*; } 2>/dev/null | true')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [omission('?*', ['/.hidden'])])
    assert.ok(result.unsupported.some(({ detail }) => detail === 'non-ASCII glob matching'))
  })

  it('retains earlier input-unit notes after a later parse failure', () => {
    const result = createTerminal(FILES).run('printf "%s\\n" *\necho $(if true)')
    assert.equal(result.stdout, 'visible\n')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.notes, [STAR_NOTE])
    assert.deepEqual(result.unsupported, [])
  })

  it('reports absolute omitted paths for a mounted non-root cwd', () => {
    const terminal = createTerminal({ 'dir/.hidden': '', 'dir/visible': '' }, { mount: '/workspace [x]', cwd: '/workspace [x]/dir' })
    assert.deepEqual(terminal.run('printf "%s\\n" ./*'), expected('./visible\n', [omission('./*', ['/workspace [x]/dir/.hidden'])], { cwd: '/workspace [x]/dir' }))
  })

  it('sees omissions in the writable overlay', () => {
    const terminal = createTerminal({}, { mount: '/repo', writable: '/tmp/' })
    const result = terminal.run('printf hidden >/tmp/.hidden; printf visible >/tmp/visible; printf "%s\\n" /tmp/*')
    assert.deepEqual(result, expected('/tmp/visible\n', [omission('/tmp/*', ['/tmp/.hidden'])], { cwd: '/repo' }))
  })

  it('freezes returned notes and resets them on later runs', () => {
    const terminal = createTerminal(FILES)
    const first = terminal.run('printf "%s\\n" *')
    assert.ok(Object.isFrozen(first.notes))
    assert.throws(() => first.notes.push('changed'), TypeError)
    assert.deepEqual(terminal.run('true'), expected())
    assert.deepEqual(first.notes, [STAR_NOTE])
  })

  it('isolates notes from a reentrant run', () => {
    let inner
    const terminal = createTerminal({ 'outer/.hidden': '', 'inner/.hidden': '' }, {
      commands: { reenter: () => { inner = terminal.run('printf "%s" inner/*'); return '' } },
    })
    const result = terminal.run('printf "%s" outer/*; reenter')
    assert.deepEqual(result.notes, [omission('outer/*', ['/outer/.hidden']), unmatched('outer/*')])
    assert.deepEqual(inner.notes, [omission('inner/*', ['/inner/.hidden']), unmatched('inner/*')])
    assert.notEqual(result.notes, inner.notes)
  })
})
