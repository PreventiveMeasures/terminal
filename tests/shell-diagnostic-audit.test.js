import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// GNU Bash 5.2.37: parse.y's read_token_word/PST_ASSIGNOK and alias.def;
// doc/bashref.texi, Aliases: definitions take effect after the entire input
// unit is read. These are in-process diagnostic regressions, not native tests.
const terminal = (commands) => createTerminal({}, { commands })
const notes = (result) => result.unsupported.map(({ kind, detail }) => [kind, detail])

function syntaxError(command, commands, prior = []) {
  const result = terminal(commands).run(command)
  assert.equal(result.exitCode, 2, command)
  assert.equal(result.stdout, '', command)
  assert.match(result.stderr, /^error: /mu, command)
  assert.deepEqual(notes(result), prior.map((detail) => ['feature', detail]), command)
}

function feature(command, detail, commands, prior = []) {
  const result = terminal(commands).run(command)
  assert.deepEqual(notes(result), [...prior, detail].map((value) => ['feature', value]), command)
  assert.notEqual(result.exitCode, 0, command)
  return result
}

describe('compound assignment diagnostics use the command operand position', () => {
  for (const command of [
    'alias LEFT=(one two)', 'alias -p LEFT=(one two)', 'alias -- LEFT=()',
    'alias LEFT+=(one two)', 'alias first=value LEFT=(one two)',
    'alias LEFT=(one two) 2>/dev/null | cat',
    '>&1 a=(one two)', 'declare >&1 a=(one two)',
  ]) {
    it(command, () => { feature(command, 'array assignment') })
  }

  for (const command of [
    'cat <a=(one)', 'prefix=x cat <a=(one)', 'prefix=x <a=(one)',
    'cat <a=()', 'cat >/dev/null () { echo ok; }',
    'declare <a=(one)', 'alias <a=(one)',
    `'declare' a=(one)`, 'decla"re" a=(one)',
  ]) {
    it(`ordinary syntax: ${command}`, () => { syntaxError(command) })
  }

  it('lets custom declaration commands receive quoted arguments normally', () => {
    const result = terminal({ declare: ({ args }) => args.join('|') }).run(`declare 'a=(one two)'`)
    assert.equal(result.stdout, 'a=(one two)')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported, [])
  })
})

describe('alias diagnostic candidates follow input boundaries and scopes', () => {
  for (const [command, prior] of [
    ["alias LEFT='('; LEFT echo one )"],
    ["alias LEFT='(' && LEFT echo one )"],
    ["{ alias LEFT='(';\nLEFT echo one ); }"],
    ["if true; then alias LEFT='(';\nLEFT echo one ); fi"],
    ["{ alias LEFT='('; } | cat\nLEFT echo one )", ['alias']],
    ["echo data | { alias LEFT='('; }\nLEFT echo one )", ['alias']],
    ["for name in one; do alias LEFT='('; done | cat\nLEFT echo one )", ['alias']],
    ["( { alias LEFT='('; } )\nLEFT echo one )", ['alias']],
    ["if false; then alias LEFT='('; fi\nLEFT echo one )"],
    ["if true; then :; else alias LEFT='('; fi\nLEFT echo one )"],
    ["if false; then :; elif false; then alias LEFT='('; fi\nLEFT echo one )"],
    ["false && alias LEFT='('\nLEFT echo one )"],
    ["true || alias LEFT='('\nLEFT echo one )"],
    ["! true && alias LEFT='('\nLEFT echo one )"],
    ["for name in; do alias LEFT='('; done\nLEFT echo one )"],
    ["alias -x LEFT='('\nLEFT echo one )", ['alias']],
  ]) {
    it(`ordinary syntax: ${command}`, () => { syntaxError(command, undefined, prior) })
  }

  for (const command of [
    "alias LEFT='(';\nLEFT echo one )",
    "{ alias LEFT='('; }\nLEFT echo one )",
    "if true; then alias LEFT='('; fi\nLEFT echo one )",
    "if false; then :; else alias LEFT='('; fi\nLEFT echo one )",
    "if false; then :; elif true; then alias LEFT='('; fi\nLEFT echo one )",
    "true && alias LEFT='('\nLEFT echo one )",
    "false || alias LEFT='('\nLEFT echo one )",
    "! false && alias LEFT='('\nLEFT echo one )",
    "for name in one; do alias LEFT='('; done\nLEFT echo one )",
    "alias -pp LEFT='('\nLEFT echo one )",
    "alias -- LEFT='('\nLEFT echo one )",
    "alias LEFT='('\nunalias LEFT; LEFT echo one )",
    "alias LEFT='('\nunalias -a; LEFT echo one )",
    "alias LEFT='('\nunalias -x LEFT\nLEFT echo one )",
    "alias LEFT='('\nfalse && unalias LEFT\nLEFT echo one )",
    "alias LEFT='('\n(unalias LEFT)\nLEFT echo one )",
    "alias LEFT='('\n{ unalias LEFT; } | cat\nLEFT echo one )",
    "alias LEFT='('\n{ LEFT echo one ) ; }",
  ]) {
    it(`alias gap: ${command}`, () => {
      const unaliasRuns = /\n(?:unalias -x|\(unalias|\{ unalias)/u.test(command)
      feature(command, 'alias expansion', undefined, unaliasRuns ? ['alias', 'unalias'] : ['alias'])
    })
  }

  it('retains alias evidence across boundaries that its replacement can change', () => {
    // LEFT opens a subshell continued across the newline in the first case.
    // Braces and parentheses in unexpanded source cannot establish reliable
    // unit boundaries once an unavailable alias has supplied grammar tokens.
    for (const command of [
      "alias LEFT='('\nLEFT\necho one )",
      "alias LEFT='('\n{ LEFT; }\necho one )",
      "alias LEFT='('\n(LEFT)\necho one )",
    ]) {
      const result = terminal().run(command)
      assert.deepEqual(notes(result), [['feature', 'alias'], ['command', 'LEFT'], ['feature', 'alias expansion']])
    }
  })

  it('does not assign builtin behavior to a custom alias command', () => {
    syntaxError("{ alias LEFT='('; }\nLEFT echo one )", { alias: () => '' })
  })

  it('does not remove builtin alias candidates through custom unalias commands', () => {
    feature("alias LEFT='('\nunalias LEFT\nLEFT echo one )", 'alias expansion', { unalias: () => '' }, ['alias'])
  })

  it('keeps possible definitions when a custom command status is unknown while parsing', () => {
    feature("probe && alias LEFT='('\nLEFT echo one )", 'alias expansion', { probe: () => '' }, ['alias'])
  })

  it('does not mistake a dynamic alias name for a literal definition', () => {
    syntaxError('alias "$name=("\nname echo one )', undefined, ['$name', 'alias'])
  })

  it('retains non-ASCII alias names that Bash allows without quoting', () => {
    feature("alias LEFT\u00A0='('\nLEFT\u00A0 echo one )", 'alias expansion', undefined, ['alias'])
  })
})

describe('deferred command substitutions preserve diagnostic and quoting boundaries', () => {
  for (const inner of ['echo @(a|b)', 'alias LEFT=(one two)']) {
    it(`validates skipped substitution syntax: ${inner}`, () => {
      const result = terminal().run(`true || printf '%s' "$(${inner})"`)
      assert.equal(result.stdout, '')
      assert.notEqual(result.stderr, '')
      assert.notEqual(result.exitCode, 0)
      assert.deepEqual(notes(result), [['feature', inner.startsWith('echo') ? 'extglob' : 'array assignment']])
    })
  }

  for (const pattern of ['@', '!', '?', '+', '*']) {
    it(`quotes and substitutions do not create ${pattern}( syntax`, () => {
      const result = terminal().run(`value='${pattern}(a|b)'; printf '%s' "$(printf '%s' "$value")"`)
      assert.equal(result.stdout, `${pattern}(a|b)`)
      assert.equal(result.stderr, '')
      assert.equal(result.exitCode, 0)
      assert.deepEqual(result.unsupported, [])
    })
  }

  it('reports inner extglob syntax before applying enclosing redirects', () => {
    const result = terminal().run(`{ printf '%s' "$(echo @(a|b) 2>/dev/null)"; } 2>/dev/null | cat`)
    assert.equal(result.stdout, '')
    assert.notEqual(result.stderr, '')
    assert.deepEqual(notes(result), [['feature', 'extglob']])
  })
})
