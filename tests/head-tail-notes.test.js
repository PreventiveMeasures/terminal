import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}\n`)
const FILES = { many: lines.join(''), short: 'one\ntwo\n', one: 'one', empty: '', utf8: 'éé\n', ascii: 'ABC', 'dir/file': '' }
const expected = (stdout = '', notes = [], extra = {}) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [], notes, ...extra })
const note = (cmd, selected, total, input = '/many', unit = 'lines') => `${cmd}: selected ${selected} of ${total} ${unit} from ${input === null ? 'standard input' : JSON.stringify(input)}.`

describe('head and tail report actual per-input truncation', () => {
  for (const [command, stdout, cmd, selected] of [
    ['head many', lines.slice(0, 10).join(''), 'head', 10],
    ['tail many', lines.slice(-10).join(''), 'tail', 10],
    ['head -n 2 many', lines.slice(0, 2).join(''), 'head', 2],
    ['tail -n2 many', lines.slice(-2).join(''), 'tail', 2],
    ['head -2 many', lines.slice(0, 2).join(''), 'head', 2],
    ['tail -2 many', lines.slice(-2).join(''), 'tail', 2],
    ['head -n +2 many', lines.slice(0, 2).join(''), 'head', 2],
    ['head -n -2 many', lines.slice(0, -2).join(''), 'head', 10],
    ['tail -n +3 many', lines.slice(2).join(''), 'tail', 10],
    ['tail -n -2 many', lines.slice(-2).join(''), 'tail', 2],
    ['head -n -99 many', '', 'head', 0],
    ['tail -n +99 many', '', 'tail', 0],
  ]) {
    it(command, () => assert.deepEqual(createTerminal(FILES).run(command), expected(stdout, [note(cmd, selected, 12)])))
  }

  it('counts a large input including an unterminated final line', () => {
    const content = Array.from({ length: 240 }, (_, i) => String(i)).join('\n')
    const result = createTerminal({ file: content }).run('head file')
    assert.deepEqual(result, expected(Array.from({ length: 10 }, (_, i) => `${i}\n`).join(''), [note('head', 10, 240, '/file')]))
  })

  it('counts empty records as lines without inventing a record after the final newline', () => {
    assert.deepEqual(createTerminal({ file: '\n\nlast' }).run('tail -n1 file'), expected('last', [note('tail', 1, 3, '/file')]))
    assert.deepEqual(createTerminal({ file: '\n\n' }).run('head -n1 file'), expected('\n', [note('head', 1, 2, '/file')]))
  })

  it('reports zero selected lines for a nonempty head input', () => {
    assert.deepEqual(createTerminal(FILES).run('head -n0 one'), expected('', [note('head', 0, 1, '/one', 'line')]))
  })

  for (const command of ['head short', 'tail short', 'head -n12 many', 'tail -n12 many', 'head -n-0 many', 'tail -n+0 many', 'tail -n+1 many', 'head -n0 empty', 'head -c0 empty', 'tail -n0 empty', 'head empty', 'tail empty']) {
    it('does not claim an omission for ' + command, () => {
      const result = createTerminal(FILES).run(command)
      assert.deepEqual(result.notes, [])
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('preserves tail zero-count behavior without opening or counting named operands', () => {
    for (const command of ['tail -n0 many missing dir', 'tail -c0 many missing dir']) {
      assert.deepEqual(createTerminal(FILES).run(command), expected())
    }
  })

  for (const operand of ['', ' -', ' /dev/stdin']) {
    it('reports known zero-count pipe omissions without consuming stdin' + operand, () => {
      const command = `cat many | { tail -n0${operand}; cat; }`
      assert.deepEqual(createTerminal(FILES).run(command), expected(FILES.many, [note('tail', 0, 12, null)]))
    })
  }

  it('does not inspect an unread file-backed input for tail zero-count notes', () => {
    assert.deepEqual(createTerminal(FILES).run('{ tail -n0; cat; } <many'), expected(FILES.many))
  })

  it('counts each operand independently and excludes banners from the counts', () => {
    const stdout = '==> many <==\nline 1\n\n==> short <==\none\n'
    assert.deepEqual(createTerminal(FILES).run('head -n1 many short'), expected(stdout, [note('head', 1, 12), note('head', 1, 2, '/short')]))
  })

  it('keeps last-option precedence for unit and banners', () => {
    assert.deepEqual(createTerminal(FILES).run('head -c1 -n1 -v -q many short'), expected('line 1\none\n', [note('head', 1, 12), note('head', 1, 2, '/short')]))
  })

  it('resolves mounted and quoted paths without changing printed operand names', () => {
    const terminal = createTerminal({ 'dir/a"b': FILES.many }, { mount: '/repo', cwd: '/repo/dir' })
    assert.deepEqual(terminal.run("head -n1 './a\"b'"), expected(lines[0], [note('head', 1, 12, '/repo/dir/a"b')], { cwd: '/repo/dir' }))
  })
})

describe('head and tail byte counts use UTF-8 bytes', () => {
  for (const [command, stdout, cmd, selected] of [
    ['head -c2 utf8', 'é', 'head', 2],
    ['tail -c3 utf8', 'é\n', 'tail', 3],
    ['head -c-1 utf8', 'éé', 'head', 4],
    ['tail -c+3 utf8', 'é\n', 'tail', 3],
    ['head -c0 utf8', '', 'head', 0],
    ['head -c-99 utf8', '', 'head', 0],
    ['tail -c+99 utf8', '', 'tail', 0],
  ]) {
    it(command, () => assert.deepEqual(createTerminal(FILES).run(command), expected(stdout, [note(cmd, selected, 5, '/utf8', 'bytes')])))
  }

  it('uses the singular unit when omitting one byte', () => {
    assert.deepEqual(createTerminal({ byte: 'X' }).run('head -c0 byte'), expected('', [note('head', 0, 1, '/byte', 'byte')]))
  })

  for (const command of ['head -c5 utf8', 'tail -c5 utf8', 'head -c-0 utf8', 'tail -c+1 utf8']) {
    it('does not add a note when ' + command + ' retains all bytes', () => {
      assert.deepEqual(createTerminal(FILES).run(command), expected(FILES.utf8))
    })
  }

  for (const command of ['head -c1 utf8', 'tail -c2 utf8', 'head -c1 ascii utf8']) {
    it('keeps partial UTF-8 unsupported without claiming that output was selected: ' + command, () => {
      const result = createTerminal(FILES).run(command)
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.length > 0)
      assert.deepEqual(result.notes, [])
    })
  }
})

describe('head and tail notes preserve streams, errors and nested invocations', () => {
  for (const [command, stdout, notes] of [
    ['cat many | head -n1', lines[0], [note('head', 1, 12, null)]],
    ['head -n1 <many', lines[0], [note('head', 1, 12, null)]],
    ['head -n1 - <many', lines[0], [note('head', 1, 12, null)]],
    ['{ head -n1; cat; } <many', FILES.many, [note('head', 1, 12, null)]],
    ['cat many | { head -n1; cat; }', lines[0], [note('head', 1, 12, null)]],
    ['cat many | head -n3 | tail -n1', lines[2], [note('head', 3, 12, null), note('tail', 1, 3, null)]],
    ['head -n1 many 2>/dev/null | cat', lines[0], [note('head', 1, 12)]],
    ['head -n1 many >/dev/null', '', [note('head', 1, 12)]],
    ['(head -n1 many)', lines[0], [note('head', 1, 12)]],
    ['value=$(head -n1 many); printf "%s" "$value"', 'line 1', [note('head', 1, 12)]],
    ['find many -exec head -n1 {} \\;', lines[0], [note('head', 1, 12)]],
    ["printf '%s' many | xargs head -n1", lines[0], [note('head', 1, 12)]],
    ['for file in many many; do head -n1 "$file"; done', lines[0].repeat(2), [note('head', 1, 12)]],
    ['false && head many; true', '', []],
  ]) {
    it(command, () => assert.deepEqual(createTerminal(FILES).run(command), expected(stdout, notes)))
  }

  it('preserves byte offsets and counts each repeated stdin operand from its current position', () => {
    assert.deepEqual(createTerminal(FILES).run('head -qc1 - - <ascii'), expected('AB', [note('head', 1, 3, null, 'bytes'), note('head', 1, 2, null, 'bytes')]))
  })

  it('uses a known writable input handle path for redirected stdin', () => {
    const terminal = createTerminal({}, { mount: '/repo', writable: '/tmp/' })
    assert.deepEqual(terminal.run("printf 'one\\ntwo\\n' >/tmp/file; head -n1 </tmp/file"), expected('one\n', [note('head', 1, 2, '/tmp/file')], { cwd: '/repo' }))
  })

  it('keeps notes for successful operands beside ordinary input failures', () => {
    assert.deepEqual(createTerminal(FILES).run('head -qn1 missing many dir'), expected(lines[0], [note('head', 1, 12)], {
      stderr: 'head: missing: no such file or directory\nhead: dir: is a directory\n', exitCode: 1,
    }))
  })

  it('retains unsupported diagnostics through hidden stderr and a succeeding pipeline', () => {
    const result = createTerminal(FILES).run('head -n1 many; head --unsupported many 2>/dev/null | true')
    assert.equal(result.stdout, lines[0])
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [note('head', 1, 12)])
    assert.ok(result.unsupported.some(({ command, detail }) => command === 'head' && detail === '--unsupported'))
  })

  it('describes selection without claiming a successful write to closed stdout', () => {
    assert.deepEqual(createTerminal(FILES).run('head -n1 many 1>&-'), expected('', [note('head', 1, 12)], {
      stderr: 'head: write error: Bad file descriptor\n', exitCode: 1,
    }))
  })

  it('keeps a later output rejection diagnostic distinct from the selected-input note', () => {
    const terminal = createTerminal({}, { mount: '/repo', writable: '/tmp/' })
    const result = terminal.run("printf 'one\\ntwo\\n' >/tmp/file; head -n1 /tmp/file >>/tmp/file 2>/dev/null | cat")
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [note('head', 1, 2, '/tmp/file')])
    assert.deepEqual(result.unsupported.map(({ command, detail }) => [command, detail]), [['head', 'streaming self-output']])
  })

  it('freezes and resets note arrays between runs', () => {
    const terminal = createTerminal(FILES)
    const first = terminal.run('head -n1 many')
    assert.deepEqual(first.notes, [note('head', 1, 12)])
    assert.ok(Object.isFrozen(first.notes))
    assert.deepEqual(terminal.run('head short').notes, [])
    assert.deepEqual(first.notes, [note('head', 1, 12)])
  })
})
