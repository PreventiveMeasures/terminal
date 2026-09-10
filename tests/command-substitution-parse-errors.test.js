import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Bash parse.y parse_comsub invokes yyparse before executing the outer input
// unit. report_syntax_error sets EX_BADUSAGE (2), and parse_comsub aborts it.
// eval.c's reader_loop executes earlier complete input units independently.
const expected = (stdout, exitCode = 0) => ({ stdout, stderr: '', exitCode, cwd: '/', notes: [], unsupported: [] })

function syntaxError(result, stdout = '') {
  assert.equal(result.stdout, stdout)
  assert.equal(result.exitCode, 2)
  assert.notEqual(result.stderr, '')
  assert.deepEqual(result.unsupported, [])
}

describe('literal command-substitution syntax errors abort outer parsing', () => {
  for (const command of [
    'echo $(if true)',
    'echo "$(if true)"',
    'value=$(if true)',
    '$(if true)',
    'echo "$(echo $(if true))"',
    'echo "$(printf before; if true)"',
    'echo $(if true) | cat',
    'false && echo $(if true)',
    'true || echo $(if true)',
    'if false; then echo $(if true); fi',
    'echo "${value:-$(if true)}"',
    'echo $((1 || $(if true)))',
    'echo $(for value in a; do)',
    'echo $(for value in a; done)',
    'echo $(echo value |)',
    'echo $(echo value &&)',
    'echo $(cat >)',
    'echo $(if true) 2>/dev/null',
    'echo $(if true); echo after',
    'echo before; echo $(if true); echo after',
    'echo "line one\nline two"; echo $(if true)',
    'cat <<$(if true)\nbody\n$(if true)',
    'cat <<"$(if true)"\nbody\n$(if true)',
  ]) {
    it(command, () => {
      const terminal = createTerminal({})
      terminal.run('value=present')
      syntaxError(terminal.run(command))
      assert.deepEqual(terminal.run('echo "$? $value"'), expected('2 present\n'))
    })
  }

  it('does not execute sibling substitutions or any command in the malformed input unit', () => {
    const calls = []
    const terminal = createTerminal({}, { commands: { probe: ({ args }) => { calls.push(args); return 'called\n' } } })
    syntaxError(terminal.run('probe before; probe "$(probe inner)" "$(if true)"; probe after'))
    assert.deepEqual(calls, [])
  })

  it('does not execute pipeline stages before finding a malformed substitution', () => {
    const calls = []
    const terminal = createTerminal({}, { commands: { probe: () => { calls.push('probe'); return 'called\n' } } })
    syntaxError(terminal.run('probe | echo $(if true) | probe'))
    assert.deepEqual(calls, [])
  })

  it('does not split a multiline brace group into independently executable units', () => {
    const calls = []
    const terminal = createTerminal({}, { commands: { probe: () => { calls.push('probe'); return '' } } })
    syntaxError(terminal.run('{\nprobe\necho $(if true)\n}'))
    assert.deepEqual(calls, [])
  })

  it('does not truncate a redirect or write from a preceding substitution in the same unit', () => {
    const terminal = createTerminal({}, { mount: '/repo', writable: '/tmp/' })
    terminal.run('printf original >/tmp/output')
    syntaxError(terminal.run('echo "$(printf changed >/tmp/output)" "$(if true)" >/tmp/output'))
    assert.deepEqual(terminal.run('cat /tmp/output'), expected('original'))
  })
})

describe('substitution parse errors preserve earlier complete input units', () => {
  it('keeps earlier output and assignments, and skips all following input', () => {
    const terminal = createTerminal({})
    syntaxError(terminal.run('value=kept; echo before\necho $(if true)\nvalue=lost; echo after'), 'before\n')
    assert.deepEqual(terminal.run('echo "$? $value"'), expected('2 kept\n'))
  })

  it('keeps earlier file writes and callbacks but no malformed-unit side effects', () => {
    const calls = []
    const terminal = createTerminal({}, {
      mount: '/repo', writable: '/tmp/',
      commands: { probe: ({ args }) => { calls.push(args); return args.join(' ') + '\n' } },
    })
    const command = 'printf kept >/tmp/output; probe before\nprintf lost >/tmp/output; probe "$(if true)"\nprobe after'
    syntaxError(terminal.run(command), 'before\n')
    assert.deepEqual(calls, [['before']])
    assert.deepEqual(terminal.run('cat /tmp/output'), expected('kept'))
  })

  it('resumes normally on a new run after the rejected input', () => {
    const terminal = createTerminal({})
    syntaxError(terminal.run('echo $(if true)'))
    assert.deepEqual(terminal.run('echo ready'), expected('ready\n'))
  })
})

describe('runtime substitution status remains distinct from parse errors', () => {
  for (const [command, stdout, exitCode] of [
    ['echo "$(false)"', '\n', 0],
    ['value=$(false)', '', 1],
    ['a=$(false) b=$(true)', '', 0],
    ['a=$(true) b=$(false)', '', 1],
    ['value=$(false); echo after', 'after\n', 0],
    ['echo "$(echo "$(false)")"; echo after', '\nafter\n', 0],
    ['echo "$(false)" | cat; echo after', '\nafter\n', 0],
    ["echo '$(if true)'", '$(if true)\n', 0],
    ["cat <<'EOF'\n$(if true)\nEOF", '$(if true)\n', 0],
    ["cat <<'$(if true)'\nbody\n$(if true)", 'body\n', 0],
    ['cat <<EOF\n\\$(if true)\nEOF', '$(if true)\n', 0],
    ['false && cat <<EOF\n$(if true)\nEOF\necho after', 'after\n', 0],
  ]) {
    it(command, () => assert.deepEqual(createTerminal({}).run(command), expected(stdout, exitCode)))
  }

  it('retains ordinary inner command failures while the outer echo succeeds', () => {
    assert.deepEqual(createTerminal({}).run('echo "$(cat missing)"; echo after'), {
      ...expected('\nafter\n'), stderr: 'cat: missing: no such file or directory\n',
    })
  })

  it('reserves 127 for command lookup failure and keeps its diagnostic', () => {
    const result = createTerminal({}).run('value=$(unavailable_command)')
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 127)
    assert.ok(result.unsupported.some(({ kind, command }) => kind === 'command' && command === 'unavailable_command'))
  })
})

describe('runtime heredoc substitution syntax gaps retain diagnostics', () => {
  for (const command of [
    'cat <<EOF\n$(if true)\nEOF',
    'printf ignored <<EOF\n$(if true)\nEOF',
    'cat <<EOF\n$((1 + $(if true)))\nEOF',
  ]) {
    it(command, () => {
      const result = createTerminal({}).run(command)
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.some(({ kind, detail }) => kind === 'feature' && detail === 'command substitution syntax'), JSON.stringify(result))
    })
  }

  it('does not call a custom command after its input expansion fails', () => {
    const calls = []
    const terminal = createTerminal({}, { commands: { probe: () => { calls.push('probe'); return 'called\n' } } })
    const result = terminal.run('probe <<EOF\n$(if true)\nEOF')
    assert.deepEqual(calls, [])
    assert.equal(result.stdout, '')
    assert.ok(result.unsupported.some(({ detail }) => detail === 'command substitution syntax'))
  })

  for (const command of [
    'cat 2>/dev/null <<EOF | true\n$(if true)\nEOF',
    '{ cat <<EOF\n$(if true)\nEOF\n} 2>/dev/null | true',
    'echo "$(cat 2>/dev/null <<EOF\n$(if true)\nEOF\n)" | true',
  ]) {
    it('survives hidden stderr and successful pipeline: ' + command, () => {
      const result = createTerminal({}).run(command)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.ok(result.unsupported.some(({ detail }) => detail === 'command substitution syntax'), JSON.stringify(result))
    })
  }
})
