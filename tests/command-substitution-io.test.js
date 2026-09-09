import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  input: 'first\nsecond\nthird\n',
  other: 'replacement\n',
  empty: '',
  'dir/space name.txt': 'one\n\ntwo\n\n',
  nul: 'a\0b\nc\0\0\n\n',
  nulOnly: '\0\0',
  nulEnd: 'before\n\0\n',
}
const READ_ERROR = 'cat: missing: no such file or directory\n'
const NUL_WARNING = 'warning: command substitution: ignored null byte in input\n'

function check(command, stdout, exitCode = 0, stderr = '') {
  assert.deepEqual(createTerminal(FILES).run(command), { stdout, stderr, exitCode, cwd: '/', unsupported: [] }, command)
}

describe('command substitution — Bash file shorthand', () => {
  const cases = [
    ['echo "$(<input)"', 'first\nsecond\nthird\n'],
    ['echo "$(< input)"', 'first\nsecond\nthird\n'],
    ['file="dir/space name.txt"; printf "<%s>\\n" "$(< "$file")"', '<one\n\ntwo>\n'],
    ['echo "$(< empty)"', '\n'],
    ['x=$(< empty); echo "$? [$x]"', '0 []\n'],
    ['echo "$(< $(printf other))"', 'replacement\n'],
    ['echo "$(<input; :)"', '\n'],
    ['echo "$(<input 2>/dev/null)"', '\n'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))

  it('reports missing or directory input without marking it unsupported', () => {
    check('x=$(<missing)', '', 1, 'error: missing: No such file or directory\n')
    check('x=$(<dir)', '', 1, 'error: dir: Is a directory\n')
    check('echo "$(<missing)"', '\n', 0, 'error: missing: No such file or directory\n')
  })
})

describe('command substitution — shared input', () => {
  const cases = [
    [String.raw`printf 'first\nsecond\n' | { x=$(cat); echo "[$x]"; cat; }`, '[first\nsecond]\n'],
    [String.raw`printf 'first\nsecond\n' | { a=$(cat) b=$(cat); echo "[$a] [$b]"; }`, '[first\nsecond] []\n'],
    ['{ x=$(cat); echo "[$x]"; cat; } < input', '[first\nsecond\nthird]\n'],
    ['{ a=$(head -n1) b=$(cat); printf "[%s] [%s]\\n" "$a" "$b"; cat; } < input', '[first] [second\nthird]\n'],
    ['{ echo "$(cat)" <other; cat; } <input', 'first\nsecond\nthird\n'],
    ['{ x=$(cat) <other; echo "$x"; cat; } <input', 'first\nsecond\nthird\n'],
    ['{ x=$(cat) echo visible <other; cat; } <input', 'visible\n'],
    ['{ echo "$(cat <other)"; cat; } <input', 'replacement\nfirst\nsecond\nthird\n'],
    ['{ echo "$(<other)"; cat; } <input', 'replacement\nfirst\nsecond\nthird\n'],
    [String.raw`printf 'first\nsecond\n' | { x=$(cat /dev/stdin); echo "[$x]"; cat; }`, '[first\nsecond]\n'],
    [String.raw`printf 'first\nsecond\n' | { x=$(</dev/stdin); echo "[$x]"; cat; }`, '[first\nsecond]\n'],
    ['{ head -n1; x=$(cat /dev/stdin); echo "[$x]"; cat; } <input', 'first\n[first\nsecond\nthird]\nsecond\nthird\n'],
    ['{ head -n1; x=$(</dev/stdin); echo "[$x]"; cat; } <input', 'first\n[first\nsecond\nthird]\nsecond\nthird\n'],
    ['f=missing; f=$(printf input) <"$f"; echo "$? $f"', '0 input\n'],
    ['f=other; f=$(printf input) cat <"$f"; echo "$f"', 'replacement\nother\n'],
  ]
  for (const [command, stdout] of cases) it(command, () => check(command, stdout))
})

describe('command substitution — expansion order and stderr', () => {
  const cases = [
    ['echo "$(cat missing)" 2>/dev/null', '\n', 0, READ_ERROR],
    ['echo 2>/dev/null "$(cat missing)"', '\n', 0, READ_ERROR],
    ['echo "$(cat missing)" 2>&1', '\n', 0, READ_ERROR],
    ['{ echo "$(cat missing)"; } 2>/dev/null', '\n', 0, ''],
    ['{ echo "$(cat missing)"; } 2>&1', READ_ERROR + '\n', 0, ''],
    ['x=$(cat missing) 2>/dev/null', '', 1, READ_ERROR],
    ['x=$(cat missing) 2>&1', '', 1, READ_ERROR],
    ['x=$(cat missing) echo visible 2>/dev/null', 'visible\n', 0, READ_ERROR],
    ['echo lost 2>/dev/null >"$(cat missing; printf /dev/null)"', '', 0, ''],
    ['echo lost >"$(cat missing; printf /dev/null)" 2>/dev/null', '', 0, READ_ERROR],
    ['echo "$(cat missing 2>/dev/null)"', '\n', 0, ''],
  ]
  for (const [command, stdout, exitCode, stderr] of cases) it(command, () => check(command, stdout, exitCode, stderr))

  it('keeps unsupported metadata even when an enclosing group suppresses assignment stderr', () => {
    const r = createTerminal(FILES).run('{ x=$(grep --unknown x input); } 2>/dev/null')
    assert.deepEqual(r, {
      stdout: '', stderr: '', exitCode: 2, cwd: '/',
      unsupported: [{ kind: 'option', command: 'grep', detail: '--unknown', message: 'grep: unknown option: --unknown' }],
    })
  })
})

describe('command substitution — NUL output', () => {
  const cases = [
    ['printf "<%s>\\n" "$(cat nul)"', '<ab\nc>\n', NUL_WARNING],
    ['printf "<%s>\\n" "$(<nul)"', '<ab\nc>\n', NUL_WARNING],
    ['echo "$(cat nulOnly)"', '\n', NUL_WARNING],
    ['echo "$(cat nulEnd)"', 'before\n', NUL_WARNING],
    ['x=$(cat nul); echo "$? [$x]"', '0 [ab\nc]\n', NUL_WARNING],
    ['echo "$(cat nulOnly)$(cat nulOnly)"', '\n', NUL_WARNING.repeat(2)],
    ['echo "$(echo "$(cat nulOnly)")"', '\n', NUL_WARNING],
    ['echo "$(cat nul)" 2>/dev/null', 'ab\nc\n', NUL_WARNING],
    ['{ echo "$(cat nul)"; } 2>/dev/null', 'ab\nc\n', ''],
    ['x=$(cat nul) 2>/dev/null; echo "$x"', 'ab\nc\n', NUL_WARNING],
    ['echo "$(cat nul >&2)"', '\n', FILES.nul],
  ]
  for (const [command, stdout, stderr] of cases) it(command, () => check(command, stdout, 0, stderr))
})
