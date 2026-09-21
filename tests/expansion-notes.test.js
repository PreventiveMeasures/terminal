import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const unmatched = (pattern) => `glob: no paths matched ${JSON.stringify(pattern)}; the pattern was left literal.`
const success = (stdout, notes = []) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', notes, unsupported: [] })

describe('unmatched pathname glob notes', () => {
  for (const pattern of ['*.js', '?', '[a-z]', '[!a]', '[[:digit:]]', 'missing/*', '*/missing', '*/', '[*', '*[', '/abs/*.ts']) {
    it(pattern, async () => {
      assert.deepEqual(await createTerminal({ visible: '' }).run(`printf '%s' ${pattern}`), success(pattern, [unmatched(pattern)]))
    })
  }

  for (const [word, value] of [
    ["'*.js'", '*.js'], ['"?"', '?'], [String.raw`\*`, '*'],
    ['[', '['], ['a[', 'a['], ['[abc', '[abc'], ['a[b/c]', 'a[b/c]'], [String.raw`\[*`, '[*'],
  ]) {
    it('distinguishes quoted and literal syntax: ' + word, async () => {
      const notes = word === String.raw`\[*` ? [unmatched(String.raw`\[*`)] : []
      assert.deepEqual(await createTerminal({}).run(`printf '%s' ${word}`), success(value, notes))
    })
  }

  it('does not treat the bracket command as a failed glob', async () => {
    assert.deepEqual(await createTerminal({ '.hidden': '' }).run('[ 1 -eq 1 ]'), success(''))
  })

  it('does not attribute hidden exclusions to an unmatched bracket in a literal parent', async () => {
    const terminal = createTerminal({ 'a[/visible': '', '.hidden/file': '' })
    assert.deepEqual(await terminal.run("printf '%s' a[/*"), success('a[/visible'))
  })

  for (const command of [
    "printf '%s' *.js >/dev/null", "printf '%s' *.js | true",
    "{ printf '%s' *.js; } 2>/dev/null | true", "x=$(printf '%s' *.js)",
    'for f in *.js; do true; done', 'pattern="*.js"; true $pattern',
  ]) {
    it('retains notes through ' + command, async () => {
      assert.deepEqual(await createTerminal({}).run(command), success('', [unmatched('*.js')]))
    })
  }

  it('keeps separate patterns in encounter order and deduplicates repeats', async () => {
    const result = await createTerminal({}).run("printf '%s' {*.js,*.ts} *.js")
    assert.deepEqual(result, success('*.js*.ts*.js', [unmatched('*.js'), unmatched('*.ts')]))
  })

  it('preserves the ordinary missing-file error after the literal fallback', async () => {
    const result = await createTerminal({}).run('cat *.js')
    assert.deepEqual(result, { ...success('', [unmatched('*.js')]), stderr: 'cat: *.js: No such file or directory\n', exitCode: 1 })
  })

  it('does not expand a glob in a skipped command', async () => {
    assert.deepEqual(await createTerminal({}).run('true || cat *.js'), success(''))
  })

  it('does not invent literal fallback when matching fails with a diagnostic', async () => {
    const result = await createTerminal({ 'café': '' }).run("printf '%s' ?*")
    assert.notEqual(result.exitCode, 0)
    assert.deepEqual(result.notes, [])
    assert.equal(result.unsupported[0]?.detail, 'non-ASCII glob matching')
  })

  it('describes an earlier literal fallback accurately when a later glob prevents dispatch', async () => {
    let called = false
    const terminal = createTerminal({ 'café': '' }, { commands: { inspect: () => { called = true; return '' } } })
    const result = await terminal.run('{ inspect *.missing ?*; } 2>/dev/null | true')
    assert.equal(called, false)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.notes, [unmatched('*.missing')])
    assert.deepEqual(result.unsupported.map(({ detail }) => detail), ['non-ASCII glob matching'])
  })

  it('retains a completed fallback when a later redirection fails before dispatch', async () => {
    let called = false
    const terminal = createTerminal({}, { commands: { inspect: () => { called = true; return '' } } })
    const result = await terminal.run('inspect *.missing </absent')
    assert.equal(called, false)
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 1)
    assert.equal(result.stderr, 'error: /absent: No such file or directory\n')
    assert.deepEqual(result.notes, [unmatched('*.missing')])
    assert.deepEqual(result.unsupported, [])
  })

  it('does not claim a fallback if an earlier expansion phase fails', async () => {
    const result = await createTerminal({}).run('printf "%s" *.missing "${value:?required}"')
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 1)
    assert.match(result.stderr, /required/u)
    assert.deepEqual(result.notes, [])
    assert.deepEqual(result.unsupported, [])
  })

  it('freezes notes and resets them on the next run', async () => {
    const terminal = createTerminal({})
    const result = await terminal.run('true *.js')
    assert.ok(Object.isFrozen(result.notes))
    assert.deepEqual(result.notes, [unmatched('*.js')])
    assert.deepEqual(await terminal.run('true'), success(''))
  })
})

describe('discarded NUL notes remain separate from stderr', () => {
  it('records distinct counts, deduplicates repeats, and excludes unexecuted substitutions', async () => {
    const result = await createTerminal({}).run(String.raw`{ x=$(printf '\0'); y=$(printf '\0\0'); z=$(printf '\0'); true || echo "$(printf '\0\0\0')"; } 2>/dev/null`)
    assert.deepEqual(result, success('', ['command substitution: discarded 1 NUL byte.', 'command substitution: discarded 2 NUL bytes.']))
  })

  it('does not note NUL bytes that remain in ordinary output', async () => {
    assert.deepEqual(await createTerminal({}).run(String.raw`printf 'a\0b' | cat`), success('a\0b'))
  })

  it('isolates reentrant notes and retains outer expansion order', async () => {
    let inner
    const terminal = createTerminal({}, { commands: { reenter: async () => {
      inner = await terminal.run(String.raw`x=$(printf '\0\0')`)
      return ''
    } } })
    const result = await terminal.run(String.raw`{ x=$(printf '\0'); reenter; } 2>/dev/null`)
    assert.deepEqual(result, success('', ['command substitution: discarded 1 NUL byte.']))
    assert.deepEqual(inner.notes, ['command substitution: discarded 2 NUL bytes.'])
    assert.deepEqual(await terminal.run('true'), success(''))
  })
})
