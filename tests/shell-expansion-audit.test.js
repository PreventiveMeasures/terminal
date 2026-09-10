import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const terminal = () => createTerminal({}, { mount: '/src', writable: '/tmp/', commands: { argv: ({ args }) => JSON.stringify(args) } })
const success = (stdout) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] })

// Bash execute_simple_command expands words before calling do_redirections;
// subst.c aborts that expansion on a fatal arithmetic or required-value error.
describe('failed argument expansion never applies command redirects', () => {
  for (const expansion of ['$((1/0))', '${missing:?required}']) {
    for (const command of [
      `echo "${expansion}" >/tmp/target`,
      `value="${expansion}" >/tmp/target`,
      `value="${expansion}" echo lost >/tmp/target`,
      `export value="${expansion}" >/tmp/target`,
    ]) {
      it(command, () => {
        const t = terminal()
        t.run('echo keep >/tmp/target')
        const result = t.run(command + '; echo lost')
        assert.equal(result.stdout, '')
        assert.notEqual(result.exitCode, 0)
        assert.notEqual(result.stderr, '')
        assert.deepEqual(t.run('cat /tmp/target'), success('keep\n'))
      })
    }

    it(`does not evaluate redirect operands after ${expansion} fails`, () => {
      const t = terminal()
      const result = t.run(`echo "${expansion}" >"$((counter=1))" >"${'${target:=/tmp/other}'}"`)
      assert.notEqual(result.exitCode, 0)
      assert.deepEqual(t.run('argv "${counter:-unset}" "${target:-unset}"'), success('["unset","unset"]'))
    })

    it(`only enclosing redirects can hide the error from ${expansion}`, () => {
      const direct = terminal().run(`echo "${expansion}" 2>/dev/null`)
      assert.notEqual(direct.stderr, '')
      const enclosed = terminal().run(`{ echo "${expansion}"; } 2>/dev/null`)
      assert.equal(enclosed.stderr, '')
      assert.notEqual(enclosed.exitCode, 0)
      assert.deepEqual(enclosed.unsupported, direct.unsupported)
    })
  }
})

// shell_expand_word_list finishes before glob_expand_word_list. Files created
// or removed by a later substitution affect pathname expansion of earlier words.
describe('pathname expansion follows all argument substitutions', () => {
  for (const command of [
    'argv /tmp/*.txt "$(printf hi >/tmp/a.txt)"',
    'argv /tmp/*.txt "${missing:-$(printf hi >/tmp/a.txt)}"',
    'argv /tmp/*.txt "$(( $(printf hi >/tmp/a.txt; printf 0) ))"',
  ]) {
    it(command, () => {
      const result = terminal().run(command)
      assert.deepEqual(result, success(JSON.stringify(['/tmp/a.txt', command.includes('$((') ? '0' : ''])))
    })
  }

  it('an earlier glob observes a later removal', () => {
    const t = terminal()
    t.run('printf hi >/tmp/a.txt')
    assert.deepEqual(t.run('argv /tmp/*.txt "$(rm /tmp/a.txt)"'), success('["/tmp/*.txt",""]'))
  })
})

describe('temporary assignments preserve other expansion side effects', () => {
  for (const [command, stdout] of [
    ['n=0; X=$((n++)) true; echo "$n"', '1\n'],
    ['n=0; X=$((n++)) true </missing; echo "$n"', '1\n'],
    ['unset value; X=${value:=set} cat </missing; echo "${value:-lost}"', 'set\n'],
    ['n=0; X=1 echo hi >/tmp/$((n=2)); echo "$n"', '2\n'],
    ['X=old; X=new echo hi >/tmp/${X:=other}; echo "$X"', 'old\n'],
    ['X=old; X=new echo hi >/tmp/$((X=2)); echo "$X"', '2\n'],
  ]) {
    it(command, () => {
      const result = terminal().run(command)
      assert.equal(result.stdout, stdout)
      assert.equal(result.exitCode, 0)
      assert.equal(result.stderr !== '', command.includes('/missing'))
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('keeps earlier RHS side effects when a later prefix expansion fails', () => {
    const t = terminal()
    const result = t.run('n=0; X=$((n++)) Y=${missing:?required} true; echo lost')
    assert.equal(result.stdout, '')
    assert.notEqual(result.exitCode, 0)
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(t.run('argv "$n" "${X-unset}" "${Y-unset}"'), success('["1","unset","unset"]'))
  })

  for (const command of [
    'n=0; n=$((n++)) true',
    'X=1 Y=$((X++)) true',
    'X=$((Y=2)) Y=1 true',
    'unset X; X=${X:=value} true',
    'unset X; Y=${X:=value} X=1 true',
  ]) {
    it(`diagnoses mutations of temporary assignment targets: ${command}`, () => {
      for (const wrap of [(source) => source, (source) => `{ ${source}; } 2>/dev/null`]) {
        const result = terminal().run(wrap(command))
        assert.notEqual(result.exitCode, 0)
        assert.ok(result.unsupported.some((entry) => entry.message.includes('modifying a temporary assignment target')))
      }
    })
  }
})

describe('continued process substitutions cannot become literal fallback text', () => {
  for (const direction of ['<', '>']) {
    const operand = direction + '\\\n(printf lost)'
    it(`diagnoses ${JSON.stringify(operand)} when selected`, () => {
      const result = terminal().run('argv ${missing:-' + operand + '}')
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.some((entry) => entry.detail === direction + '('))
    })
    it('leaves quoted operands literal and skips unselected ones', () => {
      assert.deepEqual(terminal().run('argv "${missing:-' + operand + '}"'), success(JSON.stringify([direction + '(printf lost)'])))
      assert.deepEqual(terminal().run('value=kept; argv ${value:-' + operand + '}'), success('["kept"]'))
    })
  }
})

describe('IFS presence reflects its default and explicit bindings', () => {
  it('default IFS is set, but explicit unset remains absent', () => {
    const t = terminal()
    assert.deepEqual(t.run('[[ -v IFS ]] && argv "${IFS+set}" "${IFS:-fallback}"'), success(JSON.stringify(['set', ' \t\n'])))
    assert.deepEqual(t.run('unset IFS; [[ -v IFS ]] || argv "${IFS+set}" "${IFS-fallback}"'), success('["","fallback"]'))
    assert.deepEqual(t.run('IFS=; [[ -v IFS ]] && argv "${IFS+set}" "${IFS:-fallback}"'), success('["set","fallback"]'))
  })
})
