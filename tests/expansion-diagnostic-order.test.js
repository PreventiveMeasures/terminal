import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const terminal = () => createTerminal({ input: 'present\n' })
const warning = (name) => `warning: $${name} is unset (this shell has no environment variables; only \`for\` bindings and \`NAME=value\` assignments)\n`
const missing = warning('MISSING')
const other = warning('OTHER')
const nope = 'cat: nope: no such file or directory\n'
const gone = 'cat: gone: no such file or directory\n'
const tildeError = 'error: named-user and directory-stack tilde prefixes are not supported\n'

function examples(rows) {
  for (const [name, command, stdout, stderr, names = ['MISSING'], exitCode = 0] of rows) {
    it(name, () => {
      assert.deepEqual(terminal().run(command), {
        stdout, stderr, exitCode, cwd: '/',
        notes: [], unsupported: names.map((variable) => ({ kind: 'feature', command: null, detail: '$' + variable, message: warning(variable).trimEnd() })),
      }, command)
    })
  }
}

describe('expansion diagnostics follow lexical order', () => {
  examples([
    ['review command warns before the later substitution fails', 'echo $MISSING "$(cat nope)"', '\n', missing + nope],
    ['reversing words reverses their diagnostics', 'echo "$(cat nope)" $MISSING', '\n', nope + missing],
    ['warnings and failures interleave inside one word', 'printf "<%s>" "$MISSING$(cat nope)$OTHER$(cat gone)"', '<>', missing + nope + other + gone, ['MISSING', 'OTHER']],
    ['warnings and failures interleave across words', 'printf "<%s>" "$MISSING" "$(cat nope)" "$OTHER" "$(cat gone)"', '<><><><>', missing + nope + other + gone, ['MISSING', 'OTHER']],
    ['repeated warnings retain both positions without duplicating the unsupported entry', 'printf "%s" "$MISSING$(cat nope)$MISSING"', '', missing + nope + missing],
    ['substitution output remains distinct from its error and later warnings', 'printf "<%s>" "$MISSING$(echo value; cat nope)$OTHER"', '<value>', missing + nope + other, ['MISSING', 'OTHER']],
    ['command diagnostics follow all argument expansion diagnostics', 'cat "$MISSING$(cat nope)gone"', '', missing + nope + gone, ['MISSING'], 1],
    ['a failed substitution does not change a successful ordinary command status', 'true "$MISSING$(cat nope)"', '', missing + nope],
  ])

  it('a process parameter refuses before a later substitution runs', () => {
    const message = 'error: shell parameter $ is not supported (this terminal runs no process)'
    assert.deepEqual(terminal().run('echo "$$$(cat nope)"'), {
      stdout: '', stderr: message + '\n', exitCode: 1, cwd: '/',
      notes: [], unsupported: [{ kind: 'feature', command: null, detail: '$$', message: message.slice('error: '.length) }],
    })
  })
})

describe('assignment expansion diagnostic order', () => {
  examples([
    ['assignment-only expansion retains substitution status', 'x=$MISSING"$(cat nope)"', '', missing + nope, ['MISSING'], 1],
    ['assignment-only words expand left to right', 'x=$MISSING"$(cat nope)" y=$OTHER"$(cat gone)"', '', missing + nope + other + gone, ['MISSING', 'OTHER'], 1],
    ['prefix assignment diagnostics precede the invoked command', 'x=$MISSING"$(cat nope)" echo ready', 'ready\n', missing + nope],
    ['command arguments expand before prefix assignment values', 'x=$MISSING"$(cat nope)" echo "$OTHER$(cat gone)"', '\n', other + gone + missing + nope, ['OTHER', 'MISSING']],
    ['export values interleave warning and substitution diagnostics', 'export x=$MISSING"$(cat nope)" y=$OTHER"$(cat gone)"', '', missing + nope + other + gone, ['MISSING', 'OTHER']],
    ['assignment warnings precede its own stderr redirect', 'x=$MISSING"$(cat nope)" 2>/dev/null', '', missing + nope, ['MISSING'], 1],
    ['prefix warnings precede the command stderr redirect', 'x=$MISSING"$(cat nope)" echo ready 2>/dev/null', 'ready\n', missing + nope],
    ['export argument warnings precede its stderr redirect', 'export x=$MISSING"$(cat nope)" 2>/dev/null', '', missing + nope],
  ])
})

describe('expansion diagnostics use descriptors active at the expansion site', () => {
  examples([
    ['argument expansion precedes the command stderr redirect', 'echo $MISSING "$(cat nope)" 2>/dev/null', '\n', missing + nope],
    ['argument diagnostics precede closing the command stderr', 'echo $MISSING "$(cat nope)" 2>&-', '\n', missing + nope],
    ['argument diagnostics follow an enclosing group stderr redirect', '{ echo $MISSING "$(cat nope)"; } 2>/dev/null', '\n', ''],
    ['enclosing closed stderr suppresses diagnostics without dropping unsupported entries', '{ echo "$MISSING$(cat nope)"; } 2>&-', '\n', ''],
    ['here-string expansion precedes a later stderr redirect', 'cat <<<"$MISSING$(cat nope)" 2>/dev/null', '\n', missing + nope],
    ['here-string expansion follows an earlier stderr redirect', 'cat 2>/dev/null <<<"$MISSING$(cat nope)"', '\n', ''],
    ['here-string diagnostics respect an earlier stderr close', 'cat 2>&- <<<"$MISSING$(cat nope)"', '\n', ''],
    ['here-string diagnostics survive a later stderr close', 'cat <<<"$MISSING$(cat nope)" 2>&-', '\n', missing + nope],
    ['here-string diagnostics use an earlier stderr duplication', 'cat 2>&1 <<<"$MISSING$(cat nope)"', missing + nope + '\n', ''],
    ['a later stderr duplication does not move here-string diagnostics', 'cat <<<"$MISSING$(cat nope)" 2>&1', '\n', missing + nope],
    ['input target expansion interleaves warnings and substitution errors', 'cat <"$MISSING$(cat nope)input"', 'present\n', missing + nope],
    ['input target expansion follows an earlier stderr redirect', 'cat 2>/dev/null <"$MISSING$(cat nope)input"', 'present\n', ''],
    ['input target diagnostics precede a later stderr redirect', 'cat <"$MISSING$(cat nope)input" 2>/dev/null', 'present\n', missing + nope],
    ['input target diagnostics precede a failed file open', 'cat <"$MISSING$(cat nope)absent"', '', missing + nope + 'error: absent: No such file or directory\n', ['MISSING'], 1],
    ['output target expansion precedes the output redirect', 'echo ready >"$MISSING$(cat nope)/dev/null"', '', missing + nope],
    ['redirect expansions retain order when later redirects change stderr', 'cat <<<"$MISSING$(cat nope)" 2>/dev/null <<<"$OTHER$(cat gone)"', '\n', missing + nope, ['MISSING', 'OTHER']],
    ['heredoc expansions share the same diagnostic ordering', 'cat <<END\n$MISSING$(cat nope)$OTHER$(cat gone)\nEND', '\n', missing + nope + other + gone, ['MISSING', 'OTHER']],
    ['quoted heredocs leave apparent diagnostics literal', 'cat <<\'END\'\n$MISSING$(cat nope)\nEND', '$MISSING$(cat nope)\n', '', []],
  ])
})

describe('nested expansion diagnostic order', () => {
  examples([
    ['loop words expand before body output', 'for x in "$MISSING$(cat nope)"; do echo body >&2; done', '', missing + nope + 'body\n'],
    ['loop words retain interleaved warnings across the list', 'for x in "$MISSING" "$(cat nope)" "$OTHER"; do true; done', '', missing + nope + other, ['MISSING', 'OTHER']],
    ['loop word diagnostics follow the loop stderr redirect', 'for x in "$MISSING$(cat nope)"; do true; done 2>/dev/null', '', ''],
    ['loop diagnostics retain a duplicated descriptor after closing its source', 'for x in "$MISSING$(cat nope)"; do true; done 2>&1 1>&-', missing + nope, ''],
    ['a group preserves expansion and command output event ordering when merged', '{ echo before; echo "$MISSING$(cat nope)"; echo after >&2; } 2>&1', 'before\n' + missing + nope + '\nafter\n', ''],
    ['nested substitutions retain inner lexical order', 'printf "%s" "$(printf "%s" "$MISSING$(cat nope)$OTHER")"', '', missing + nope + other, ['MISSING', 'OTHER']],
    ['outer and inner expansion diagnostics retain their boundaries', 'printf "%s" "$MISSING$(printf "%s" "$OTHER$(cat nope)")$LAST"', '', missing + other + nope + warning('LAST'), ['MISSING', 'OTHER', 'LAST']],
    ['substitution NUL diagnostics stay between surrounding parameter warnings', String.raw`printf "%s" "$MISSING$(printf 'a\0b'; cat nope)$OTHER"`, 'ab', missing + nope + 'warning: command substitution: ignored null byte in input\n' + other, ['MISSING', 'OTHER']],
    ['conditional execution does not emit diagnostics for a skipped branch', 'if true; then echo "$MISSING$(cat nope)"; else echo "$OTHER$(cat gone)"; fi', '\n', missing + nope],
    ['an enclosing redirect suppresses nested warnings but keeps their unsupported entries', '{ printf "%s" "$MISSING$(printf "%s" "$OTHER$(cat nope)")"; } 2>/dev/null | cat', '', '', ['MISSING', 'OTHER']],
  ])
})

describe('diagnostics emitted before later expansion failures remain visible', () => {
  for (const [name, command, expected] of [
    ['later argument expansion failure', 'echo "$MISSING" ~someone', missing + tildeError],
    ['later assignment value expansion failure', 'x=$MISSING y=~someone', missing + tildeError],
    ['later prefix value expansion failure', 'x=$MISSING y=~someone echo ready', missing + tildeError],
    ['later export value expansion failure', 'export x=$MISSING y=~someone', missing + tildeError],
    ['later redirect target expansion failure', 'echo "$MISSING" >~someone', missing + tildeError],
    ['later loop word expansion failure', 'for x in "$MISSING" ~someone; do echo unexpected; done', missing + tildeError],
    ['earlier substitution and warning before a later failure', 'echo "$(cat nope)$MISSING" ~someone', nope + missing + tildeError],
  ]) {
    it(name, () => {
      const result = terminal().run(command)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, expected)
      assert.equal(result.exitCode, 1)
      assert.deepEqual(result.unsupported.map((entry) => entry.detail), ['$MISSING', 'tilde prefix'])
    })
  }

  it('keeps a warning before word splitting rejects unsupported IFS', () => {
    const result = terminal().run('IFS=:; echo $MISSING "$(cat nope)"')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, missing + 'error: custom IFS separators are not supported\n')
    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.unsupported.map((entry) => entry.detail), ['$MISSING', 'IFS'])
  })

  it('preserves both unsupported entries when enclosing redirects hide a later failure', () => {
    const result = terminal().run('{ echo "$MISSING" ~someone; } 2>/dev/null | cat')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported.map((entry) => entry.detail), ['$MISSING', 'tilde prefix'])
  })
})
