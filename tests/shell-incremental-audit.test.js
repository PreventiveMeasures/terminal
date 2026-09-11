import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Bash5.2.37 parse.y: inputunit accepts a newline only after simple_list;
// AND_AND, OR_OR and pipelines consume newline_list inside that same unit.
// Here-documents are gathered before parsing resumes after their physical line.
function terminal() {
  const calls = []
  const shell = createTerminal({}, {
    mount: '/repo', writable: '/tmp/',
    commands: { probe: ({ args }) => { calls.push(args); return args.join(' ') + '\n' } },
  })
  return { calls, shell }
}

const expected = (stdout = '') => ({ stdout, stderr: '', exitCode: 0, cwd: '/repo', notes: [], unsupported: [] })

function syntaxFailure(result, stdout) {
  assert.equal(result.stdout, stdout)
  assert.equal(result.exitCode, 2)
  assert.notEqual(result.stderr, '')
  assert.deepEqual(result.unsupported, [])
  assert.deepEqual(result.notes, [])
}

describe('a completed compound remains attached to a continued operator', () => {
  for (const [compound, operator, stdout, calls] of [
    ['{\nprobe group\n}', '|', 'group\n', [['group']]],
    ['if true\nthen\nprobe branch\nfi', '&&', 'branch\n', [['branch']]],
    ['for x in one two\ndo\nprobe "$x"\ndone', '||', 'one\ntwo\n', [['one'], ['two']]],
  ]) {
    it(`keeps ${operator} after the closer in the unexecuted unit`, () => {
      const t = terminal()
      syntaxFailure(t.shell.run('probe before\n' + compound + ' ' + operator + '\n# continued operand\nprobe broken )'), 'before\n')
      assert.deepEqual(t.calls, [['before']])
    })

    it(`accepts the compound when a newline precedes ${operator}`, () => {
      const t = terminal()
      syntaxFailure(t.shell.run(compound + '\n' + operator + ' probe broken'), stdout)
      assert.deepEqual(t.calls, calls)
    })
  }

  it('does not scan a later unterminated quote before returning a completed subshell', () => {
    const t = terminal()
    syntaxFailure(t.shell.run('(\nprobe subshell\n)\nprobe "unterminated'), 'subshell\n')
    assert.deepEqual(t.calls, [['subshell']])
  })

  it('does not execute a completed inner block before a malformed outer block closes', () => {
    const t = terminal()
    syntaxFailure(t.shell.run('probe before\n{\n(probe inner\n)\nprobe "unterminated'), 'before\n')
    assert.deepEqual(t.calls, [['before']])
  })
})

describe('here-document collection resumes inside the original grammar context', () => {
  for (const [source, stdout, calls] of [
    ['{\ncat <<A\none\nA\ncat <<B\ntwo\nB\n}\nprobe after', 'one\ntwo\nafter\n', [['after']]],
    ["cat <<'A' | { cat\n) fi ; &&\nA\nprobe inside\n}\nprobe after", ') fi ; &&\ninside\nafter\n', [['inside'], ['after']]],
    ["if cat <<'A'\ncondition\nA\nthen\nprobe branch\nfi\nprobe after", 'condition\nbranch\nafter\n', [['branch'], ['after']]],
    ["for x in $(cat <<'A'\none two\nA\n)\ndo probe \"$x\"\ndone\nprobe after", 'one\ntwo\nafter\n', [['one'], ['two'], ['after']]],
    ['if false\nthen cat <<A\n$(if true)\nA\nelse probe kept\nfi\nprobe after', 'kept\nafter\n', [['kept'], ['after']]],
  ]) {
    it(source, () => {
      const t = terminal()
      assert.deepEqual(t.shell.run(source), expected(stdout))
      assert.deepEqual(t.calls, calls)
    })
  }

  it('does not expand a gathered heredoc when the enclosing compound is malformed', () => {
    const t = terminal()
    const source = 'probe before\nif true\nthen cat <<A\n$(probe payload)\nA\nfi )'
    syntaxFailure(t.shell.run(source), 'before\n')
    assert.deepEqual(t.calls, [['before']])
  })

  it('does not apply a group redirect before a later continued stage has parsed', () => {
    const t = terminal()
    t.shell.run('printf kept >/tmp/out')
    const source = '{\ncat <<A\nchanged\nA\n} >/tmp/out &&\nprobe "unterminated'
    syntaxFailure(t.shell.run(source), '')
    assert.deepEqual(t.calls, [])
    assert.deepEqual(t.shell.run('cat /tmp/out'), expected('kept'))
  })
})

describe('nested substitutions do not introduce premature execution boundaries', () => {
  it('validates a multiline for-list substitution before any command in its outer unit', () => {
    const t = terminal()
    const source = 'probe before\nfor x in $(probe candidate\nif true)\ndo probe "$x"\ndone'
    syntaxFailure(t.shell.run(source), 'before\n')
    assert.deepEqual(t.calls, [['before']])
  })

  it('defers valid inner input units until their whole outer compound has parsed', () => {
    const t = terminal()
    const source = 'probe before\n{\nprobe "$(probe first\nprobe second)"\nprobe )\n}'
    syntaxFailure(t.shell.run(source), 'before\n')
    assert.deepEqual(t.calls, [['before']])
  })

  it('rejects malformed substitution syntax in a later skipped multiline branch', () => {
    const t = terminal()
    const source = 'probe before\nif true\nthen probe selected\nelse probe "$(if true)"\nfi'
    syntaxFailure(t.shell.run(source), 'before\n')
    assert.deepEqual(t.calls, [['before']])
  })

  it('keeps diagnostics from earlier complete units but none from the malformed unit', () => {
    const t = terminal()
    const source = 'missing_command\nprobe before\n{\nother_missing_command\nprobe "$(if true)"\n}'
    const result = t.shell.run(source)
    assert.equal(result.stdout, 'before\n')
    assert.equal(result.exitCode, 2)
    assert.deepEqual(result.unsupported.map((note) => note.command), ['missing_command'])
    assert.deepEqual(t.calls, [['before']])
  })
})

describe('scanner state resets only at accepted input boundaries', () => {
  it('re-evaluates conditional command position after each accepted unit', () => {
    const t = terminal()
    const source = 'probe [[\n[[ 1 -eq 1 ]] &&\nprobe yes\nprobe [[ -n literal ]]\n[[ -n "" ]] || probe fallback'
    assert.deepEqual(t.shell.run(source), expected('[[\nyes\n[[ -n literal ]]\nfallback\n'))
    assert.deepEqual(t.calls, [['[['], ['yes'], ['[[', '-n', 'literal', ']]'], ['fallback']])
  })

  it('keeps continued dollar references and multiline quoted words in their own unit', () => {
    const t = terminal()
    const source = 'x=one\nprobe $\\\nx "two\nthree"\nprobe after\nprobe )'
    syntaxFailure(t.shell.run(source), 'one two\nthree\nafter\n')
    assert.deepEqual(t.calls, [['one', 'two\nthree'], ['after']])
  })

  it('does not treat operators mentioned in comments as grammar lookahead', () => {
    const t = terminal()
    const source = '{\nprobe first # } && "\n}\n# | $(if true)\nprobe second # ;\nprobe )'
    syntaxFailure(t.shell.run(source), 'first\nsecond\n')
    assert.deepEqual(t.calls, [['first'], ['second']])
  })
})
