import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU Bash5.2.37 parse.y distinguishes reserved-word positions from ordinary
// command words and redirection operands. Single quotes preserve literal
// backslash/newline in parameter operands; variables.c supplies Bash state.
const FILES = { '[[': 'literal\n', 'a.txt': 'data\n', 'space file': 'space\n', 'a.js': 'a', 'b.js': 'b' }
const terminal = () => createTerminal(FILES, { commands: { argv: ({ args }) => JSON.stringify(args) } })
const success = (stdout) => ({ stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] })

describe('conditional keywords and compound expansion boundaries', () => {
  for (const [command, stdout] of [
    ['[[(-f a.txt)]] && printf yes', 'yes'],
    ['if [[(-f a.txt)]]; then printf yes; fi', 'yes'],
    ['! [[ -f absent ]]; printf "%s" "$?"', '0'],
    ['if false; then :; elif [[ -f a.txt ]]; then printf yes; fi', 'yes'],
    ['for name in a.txt; do [[ -f $name ]] && printf "%s" "$name"; done', 'a.txt'],
    ['([[ -f a.txt ]]) && printf yes', 'yes'],
    ['[[ -f a.txt ]] </dev/null && printf yes', 'yes'],
    ['printf "%s" "$(if [[(-f a.txt)]]; then printf yes; fi)"', 'yes'],
    ['printf "%s" "$([[ -f a.txt ]] && printf yes)"', 'yes'],
    ['for word in [[ a ]]; do printf "<%s>" "$word"; done', '<[[><a><]]>'],
    ['printf "%s" "$(printf %s [[)"', '[['],
    ['printf "%s" "$(cat < [[)"', 'literal'],
    ['printf "%s" "$(< [[)"', 'literal'],
    ['cat <<[[\nbody\n[[', 'body\n'],
    ['printf "%s" "$(cat <<[[\nbody\n[[\n)"', 'body'],
    ['printf "<%s>" "$(<<[[\nbody\n[[\n)"', '<>'],
    ['n=2; argv "${missing:-$(if [[ $((n + 1)) -eq 3 ]]; then printf yes; fi)}"', '["yes"]'],
    ['argv "$((1 + ${missing:-2}))"', '["3"]'],
    ['[[ ${missing:-$(printf "a b")} == "a b" ]] && printf yes', 'yes'],
    ['x=abc.txt; [[ ${x%.*} == abc ]] && printf yes', 'yes'],
    ['argv "${missing:-a\\}b}"', '["a}b"]'],
    ['present=ok; argv ${present:-<(cat a.txt)}', '["ok"]'],
    ["argv ${missing:-'a\\\nb'}", JSON.stringify(['a\\\nb'])],
    ["argv ${missing:-'\\\n'}", JSON.stringify(['\\\n'])],
    ["x='a\\\nb'; argv ${x#'a\\\n'}", '["b"]'],
    ['argv ${missing:-a\\\nb}', '["ab"]'],
    ['argv "${missing:-$"a b"}"', '["a b"]'],
    ['value=inner; argv "${missing:-$"a $value"}"', '["a inner"]'],
    ['argv ${missing:-"a\\\nb"}', '["ab"]'],
    ['value=""; [[ -z ${value:-} ]] && argv "${value:-}"', '[""]'],
    ['argv "${@}" "$@" "$*"', '[""]'],
    ['argv "${missing:-$((2 + 3))}" "${other:-$(printf x)}"', '["5","x"]'],
  ]) {
    it(command, () => { assert.deepEqual(terminal().run(command), success(stdout), command) })
  }
})

describe('parameter words preserve empty arguments, field splitting, and glob quoting', () => {
  for (const [command, args] of [
    ['argv ${missing:+word}', []],
    ['argv "${missing:+word}"', ['']],
    ['argv ${missing:-""}', ['']],
    ['argv ${missing:-"a b"}', ['a b']],
    ['argv ${missing:-a b}', ['a', 'b']],
    ['argv ${missing:-*.js}', ['a.js', 'b.js']],
    ['argv "${missing:-*.js}"', ['*.js']],
    ['argv ${missing:-"*.js"}', ['*.js']],
    ['argv ${missing:="a b"} "$missing"', ['a', 'b', 'a b']],
    ['argv ${@} ${1:+unexpected}', []],
    ["argv ${missing:-'{a,b}'}", ['{a,b}']],
    ['argv ${missing:-""}suffix', ['suffix']],
  ]) {
    it(command, () => { assert.deepEqual(terminal().run(command), success(JSON.stringify(args)), command) })
  }
})

describe('unsupported expansion paths retain independent diagnostics', () => {
  for (const command of [
    'printf "%s" "${BASH_COMMAND:-fallback}"',
    '[[ -v OSTYPE ]]',
    '[[ ${GROUPS:-missing} == missing ]]',
    'printf "%s" "${BASH_ARGV0:-fallback}"',
    'printf "%s" "${BASH:-fallback}"',
    '{ argv ${missing:-<(printf data)}; } 2>/dev/null | cat',
    'for path in a.txt; do [[ -r "$path" ]] 2>/dev/null; done | cat',
    'for value in "${x/old/new}"; do printf "%s" "$value"; done 2>/dev/null | cat',
    'printf "%s" "$(printf "%s" "${x@Q}")" 2>/dev/null | cat',
    '[[ ${x:-$((1 / 0))} == anything ]] 2>/dev/null | cat',
  ]) {
    it(command, () => {
      const result = terminal().run(command)
      assert.equal(result.stdout, '', command)
      assert.ok(result.unsupported.length > 0, command)
    })
  }

  it('does not silently execute [[ as a conditional after a leading redirect', () => {
    for (const command of ['</dev/null [[ -f a.txt ]] && printf wrong', 'printf "%s" "$(</dev/null [[ -f a.txt ]] && printf wrong)"']) {
      const result = terminal().run(command)
      assert.equal(result.stdout, '', command)
      assert.ok(result.unsupported.length > 0, command)
      assert.match(result.stderr, /command not found/u, command)
    }
  })
})

// A selected operand is still an expansion context: unavailable process state
// or ANSI-C text that would require another expansion pass must fail explicitly.
describe('selected parameter operands reject unavailable expansions', () => {
  for (const command of [
    'argv ${missing:-$RANDOM}',
    'argv "${missing:-$PATH}"',
    'argv ${missing:=$BASHPID}',
    'argv "${missing:-$\'$RANDOM\'}"',
    'argv "${missing:-$\'$(printf lost)\'}"',
    'argv "${missing:-$\'\\\\$RANDOM\'}"',
  ]) {
    it(command, () => {
      const result = terminal().run(command)
      assert.equal(result.stdout, '')
      assert.notEqual(result.exitCode, 0)
      assert.ok(result.unsupported.length > 0)
    })
  }
})
