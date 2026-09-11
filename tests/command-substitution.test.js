import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'src/a.js': 'export const a = 1\n// TODO\n',
  'src/b.js': 'export const b = 2\n',
  'src/space name.txt': 'space name\n',
  names: 'src/a.js\nsrc/b.js\n',
  multiline: 'first\n\nsecond\n\n\n',
  syntax: '$HOME; echo injected | cat\n',
}
const options = { commands: { capture: ({ args }) => JSON.stringify(args) + '\n' } }
const terminal = () => createTerminal(FILES, options)

function check(command, stdout, exitCode = 0, stderr = '', notes = []) {
  assert.deepEqual(terminal().run(command), { stdout, stderr, exitCode, cwd: '/', notes, unsupported: [] }, command)
}

describe('command substitution — output and shell words', () => {
  const cases = [
    ['echo $(pwd)', '/\n'],
    ['echo "$(pwd)"', '/\n'],
    [String.raw`printf '<%s>\n' "$(cat multiline)"`, '<first\n\nsecond>\n'],
    [String.raw`printf '<%s>\n' "$(printf '\n\n')"`, '<>\n'],
    [String.raw`printf '%s\n' a$(printf '\nx\n\n')b`, 'a\nxb\n'],
    [String.raw`printf '%s\n' "$(printf a)$(printf b)"`, 'ab\n'],
    [String.raw`printf '<%s>\n' "$(printf '%s' "$(printf hello)")"`, '<hello>\n'],
    [String.raw`echo $(printf '%s' ')')`, ')\n'],
    [String.raw`echo $(printf '%s' "(")`, '(\n'],
    [String.raw`echo $(printf '%s' \))`, ')\n'],
    [String.raw`echo '$(pwd)' "\$(pwd)"`, '$(pwd) $(pwd)\n'],
    ['$(printf echo) hello', 'hello\n'],
    ['cat "$(printf \'src/space name.txt\')"', 'space name\n'],
    ['files=$(ls src); printf "%s\\n" "$files"', 'a.js\nb.js\nspace name.txt\n'],
    ['count=$(grep -c TODO src/a.js); echo "count=$count"', 'count=1\n'],
    ['for f in $(cat names); do basename "$f"; done', 'a.js\nb.js\n'],
    ['echo "$(find src -name \'*.js\' | wc -l) files"', '2 files\n'],
    ['echo "$(cat syntax)"', '$HOME; echo injected | cat\n'],
    ['echo "$(echo first; echo second)"', 'first\nsecond\n'],
    ['echo "$( (echo nested); echo after )"', 'nested\nafter\n'],
    ['echo "$(echo first # ignored )\necho second)"', 'first\nsecond\n'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))

  const words = [
    [String.raw`capture $(printf ' a\tb\n\nc \n')`, ['a', 'b', 'c']],
    [String.raw`capture "$(printf ' a\tb\n\nc \n')"`, [' a\tb\n\nc ']],
    [String.raw`capture $(printf '')`, []],
    [String.raw`capture "$(printf '')"`, ['']],
    [String.raw`capture before $(printf '') after`, ['before', 'after']],
    [String.raw`capture pre$(printf 'a b')post`, ['prea', 'bpost']],
    [String.raw`capture pre$(printf '')post`, ['prepost']],
    [String.raw`capture $(printf 'src/*.js\n')`, ['src/a.js', 'src/b.js']],
    [String.raw`capture "$(printf 'src/*.js\n')"`, ['src/*.js']],
    [String.raw`capture $(printf 'missing*.js\n')`, ['missing*.js'], ['glob: no paths matched "missing*.js"; the pattern was left literal.']],
    [String.raw`capture $(printf '%s' 'a\ b')`, ['a\\', 'b']],
    [String.raw`capture $(printf '%s' "'a b'")`, ["'a", "b'"]],
    [String.raw`capture $(printf 'a\rb')`, ['a\rb']],
    [String.raw`capture $(printf '%s' 'a b')`, ['a b']],
    ['capture $(cat syntax)', ['$HOME;', 'echo', 'injected', '|', 'cat']],
  ]
  for (const [command, args, notes] of words) it(command, () => check(command, JSON.stringify(args) + '\n', 0, '', notes))

  it('does not split or glob command output in assignment values', () => {
    check(String.raw`x=$(printf ' src/*.js\nsecond\n'); capture "$x"`, '[" src/*.js\\nsecond"]\n')
  })
})

describe('command substitution — state and status', () => {
  const cases = [
    ['x=$(false)', '', 1],
    ['x=$(true)', '', 0],
    ['x=$(true) y=$(false)', '', 1],
    ['x=$(false) y=$(true)', '', 0],
    ['x=$(false) y=literal', '', 1],
    ['echo "$(false)"', '\n', 0],
    ['false "$(true)"', '', 1],
    ['export x=$(false); echo "$?"', '0\n', 0],
    ['false; x=$(echo "$?"); echo "$x"', '1\n', 0],
    ['capture "$(false)" "$?"', '["","1"]\n', 0],
    ['x=$(false) y=$?; echo "$y $?"', '1 1\n', 0],
    ['x=$(printf before; exit 7; echo lost); echo "$? $x"', '7 before\n', 0],
    ['echo "$(echo before; exit 7; echo lost)"; echo after', 'before\nafter\n', 0],
    ['x=outer; y=$(x=inner; echo "$x"); echo "$x $y"', 'outer inner\n', 0],
    ['x=outer; y=$(unset x; x=inner; echo "$x"); echo "$x $y"', 'outer inner\n', 0],
    ['x=$(cd src; pwd); echo "$x"; pwd', '/src\n/\n', 0],
    ['x=one; y=$(echo "$x"); x=two; z=$(echo "$x"); echo "$y $z"', 'one two\n', 0],
    ['false && echo "$(cat missing)"', '', 1],
    ['true || echo "$(cat missing)"', '', 0],
    ['x=$(false) && echo lost || echo recovered', 'recovered\n', 0],
    ['for x in one two; do echo "$(echo "$x")"; done', 'one\ntwo\n', 0],
  ]
  for (const [command, stdout, exitCode] of cases) it(command, () => check(command, stdout, exitCode))

  it('keeps changes inside nested substitutions isolated at each level', () => {
    check('x=outer; echo "$(x=middle; echo "$(x=inner; echo "$x")"; echo "$x")"; echo "$x"', 'inner\nmiddle\nouter\n')
  })

  it('does not consume the enclosing loop when break runs inside a substitution', () => {
    const r = terminal().run('for f in a b; do echo "$(break; echo "$f")"; done')
    assert.equal(r.stdout, 'a\nb\n')
    assert.equal(r.exitCode, 0)
    assert.match(r.stderr, /break: only meaningful in a `for` loop/u)
    assert.deepEqual(r.unsupported, [])
  })
})

describe('command substitution — redirects and diagnostics', () => {
  it('retains stderr separately from captured stdout', () => {
    check('echo "$(cat missing; echo kept)"', 'kept\n', 0, 'cat: missing: no such file or directory\n')
    check('x=$(cat missing)', '', 1, 'cat: missing: no such file or directory\n')
    // The read error went to /dev/null, so only the note carries it.
    check('echo "$(cat missing 2>/dev/null; echo kept)"', 'kept\n', 0, '',
      ['cat: no such file or directory: "missing".'])
  })

  it('captures stderr only when the inner command redirects it to stdout', () => {
    check('echo "$(cat missing 2>&1)"', 'cat: missing: no such file or directory\n')
  })

  it('supports substitution in input redirection and here-strings', () => {
    check('cat < "$(printf names)"', 'src/a.js\nsrc/b.js\n')
    check('cat <<< "$(printf \'a\\nb\\n\\n\')"', 'a\nb\n')
    check('echo gone > "$(printf /dev/null)"', '')
  })

  it('expands unquoted heredocs but leaves quoted heredocs literal', () => {
    check('cat <<EOF\n$(echo first)\n$(printf \'second\\n\\n\')\nEOF', 'first\nsecond\n')
    check("cat <<'EOF'\n$(echo literal)\nEOF", '$(echo literal)\n')
    check('echo "$(cat <<EOF\na)\nb\nEOF\n)"', 'a)\nb\n')
  })

  it('preserves unsupported diagnostics even when inner stderr and the final status are hidden', () => {
    const command = 'echo "$(grep --unknown x src/a.js 2>/dev/null)" | true'
    const message = 'grep: unknown option: --unknown'
    assert.deepEqual(terminal().run(command), {
      stdout: '', stderr: '', exitCode: 0, cwd: '/',
      notes: [], unsupported: [{ kind: 'option', command: 'grep', detail: '--unknown', message }],
    })
  })

  it('deduplicates diagnostics across substitutions without losing encounter order', () => {
    const r = terminal().run('echo "$(grep --unknown x src/a.js 2>/dev/null)$(sed -i s/a/A/ src/a.js 2>/dev/null)$(grep --unknown x src/a.js 2>/dev/null)"')
    assert.equal(r.stdout, '\n')
    assert.equal(r.stderr, '')
    assert.equal(r.exitCode, 0)
    assert.deepEqual(r.unsupported.map(({ command, detail }) => [command, detail]), [['grep', '--unknown'], ['sed', '-i']])
  })

  it('does not execute substitutions in skipped branches', () => {
    const r = terminal().run('false && echo "$(grep --unknown x src/a.js)"; true || echo "$(grep --unknown x src/a.js)"')
    assert.deepEqual(r, { stdout: '', stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [] })
  })

  it('reports malformed substitution syntax as an error without throwing', () => {
    for (const command of ['echo $(pwd', 'echo "$(pwd)', 'echo $(echo "unterminated)', 'x=$(echo a |)']) {
      const r = terminal().run(command)
      assert.notEqual(r.exitCode, 0, command)
      assert.notEqual(r.stderr, '', command)
      assert.deepEqual(r.unsupported, [], command)
    }
  })
})
