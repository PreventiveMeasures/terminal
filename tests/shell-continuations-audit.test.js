import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Bash parse.y uses shell_getc(1) for token and operator lookahead; quoted
// strings and heredoc bodies retain their own continuation rules.
const continuation = '\\\n'
const terminal = () => createTerminal({ input: 'source\n' }, { mount: '/repo', writable: '/tmp/' })
const expected = (stdout, stderr = '', exitCode = 0) => ({ stdout, stderr, exitCode, cwd: '/repo', notes: [], unsupported: [] })

function insertContinuations(operator) {
  return [...operator].join(continuation)
}

describe('continued shell control and redirection operators', () => {
  for (const [command, stdout, stderr] of [
    [`true ${insertContinuations('&&')} echo yes`, 'yes\n'],
    [`false ${insertContinuations('&&')} echo wrong; echo after`, 'after\n'],
    [`false ${insertContinuations('||')} echo yes`, 'yes\n'],
    [`true ${insertContinuations('||')} echo wrong; echo after`, 'after\n'],
    [`printf hi ${insertContinuations('>&2')}`, '', 'hi'],
    [`printf hi ${insertContinuations('1>&2')}`, '', 'hi'],
    [`cat ${insertContinuations('0<')}/repo/input`, 'source\n'],
    [`cat ${insertContinuations('0<&0')} <<< input`, 'input\n'],
    [`cat ${insertContinuations('<<<')} 'a b'`, 'a b\n'],
    [`echo "$(cat ${insertContinuations('<<<')} 'a b')"`, 'a b\n'],
    [`( ${continuation}(echo yes))`, 'yes\n'],
    [`true &${continuation.repeat(3)}& echo yes`, 'yes\n'],
  ]) {
    it(JSON.stringify(command), () => assert.deepEqual(terminal().run(command), expected(stdout, stderr)))
  }

  it('keeps a descriptor prefix attached to its redirect', () => {
    const shell = terminal()
    assert.deepEqual(shell.run(`echo hi 2${continuation}>/tmp/error`), expected('hi\n'))
    assert.deepEqual(shell.run('cat /tmp/error'), expected(''))
    const error = shell.run(`cat /repo/missing 2${continuation}>/tmp/error`)
    assert.equal(error.stdout, '')
    assert.equal(error.stderr, '')
    assert.equal(error.exitCode, 1)
    assert.deepEqual(error.unsupported, [])
    assert.match(shell.run('cat /tmp/error').stdout, /cat:.*missing/u)
  })

  for (const operator of ['>>', '&>>']) {
    it('preserves append mode for ' + operator, () => {
      const shell = terminal()
      assert.deepEqual(shell.run(`printf first >/tmp/output; printf second ${insertContinuations(operator)}/tmp/output; cat /tmp/output`), expected('firstsecond'))
    })
  }

  for (const operator of ['&>', '&>>']) {
    it('combines both output streams for ' + operator, () => {
      assert.deepEqual(terminal().run(`{ printf out; printf err >&2; } ${insertContinuations(operator)}/tmp/output; cat /tmp/output`), expected('outerr'))
    })
  }

  it('preserves explicit overwrite mode', () => {
    assert.deepEqual(terminal().run(`printf old >/tmp/output; printf new ${insertContinuations('>|')}/tmp/output; cat /tmp/output`), expected('new'))
  })

  it('preserves a continued stderr pipeline', () => {
    const result = terminal().run(`cat /repo/missing ${insertContinuations('|&')} cat`)
    assert.match(result.stdout, /cat:.*missing/u)
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported, [])
  })

  it('closes the continued output descriptor', () => {
    const result = terminal().run(`printf hi ${insertContinuations('1>&-')}`)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /write error/u)
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported, [])
  })
})

describe('continued heredoc operators and substitution boundaries', () => {
  for (const [command, stdout] of [
    [`cat ${insertContinuations('<<')}END\nbody\nEND`, 'body\n'],
    [`cat ${insertContinuations('<<-')}END\n\tbody\n\tEND`, 'body\n'],
    [`cat <<EN${continuation}D\nbody\nEND`, 'body\n'],
    [`cat <<END\na${continuation}b\nEND`, 'ab\n'],
    [`cat <<'END'\na${continuation}b\nEND`, `a${continuation}b\n`],
    [`printf '%s' "$(cat ${insertContinuations('<<')}END\n)body\nEND\n)"`, ')body'],
    [`printf '%s' "$(cat ${insertContinuations('<<-')}END\n\t)body\n\tEND\n)"`, ')body'],
    [`printf '%s' "$(cat <<$${continuation}'END'\n)body\nEND\n)"`, ')body'],
    [`printf '%s' "$(cat <<$${continuation}"END"\n)body\nEND\n)"`, ')body'],
    [`printf '%s' "$(printf '%s' $${continuation}${String.raw`'a\'b)'`})"`, "a'b)"],
  ]) {
    it(JSON.stringify(command), () => assert.deepEqual(terminal().run(command), expected(stdout)))
  }
})

describe('continuation recognition respects literal and quoted text', () => {
  for (const [command, stdout] of [
    [`printf '%s' '2${continuation}>'`, `2${continuation}>`],
    [`printf '%s' "2${continuation}>"`, '2>'],
    [`printf '%s' 2\\\\\nprintf next`, '2\\next'],
    [`echo before # comment ${continuation}echo after`, 'before\nafter\n'],
    [`echo hi '2'${continuation}>/tmp/output; cat /tmp/output`, 'hi 2\n'],
    [`echo hi cat2${continuation}>/tmp/output; cat /tmp/output`, 'hi cat2\n'],
  ]) {
    it(JSON.stringify(command), () => assert.deepEqual(terminal().run(command), expected(stdout)))
  }
})

describe('continued unsupported constructs retain their diagnostics', () => {
  for (const [command, detail] of [
    [`cat <${continuation}(printf x)`, '<('],
    [`printf x >${continuation}(cat)`, '>('],
    [`echo "$(cat <${continuation}(printf x))"`, '<('],
    [`cat <${continuation}>/tmp/file`, '<>'],
    [`(${continuation}(1))`, '(('],
    [`echo hi 1${continuation}0>/tmp/file`, '10>'],
    [`printf hi >&1${continuation}word`, 'redirect target'],
    ['printf hi >&1\rword', 'redirect target'],
    ['printf hi >&1\u00A0word', 'redirect target'],
  ]) {
    it(JSON.stringify(command), () => {
      const result = terminal().run(command)
      assert.ok(result.unsupported.some((note) => note.detail === detail), JSON.stringify(result))
    })
  }
})
