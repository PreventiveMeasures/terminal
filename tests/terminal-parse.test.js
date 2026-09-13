import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { URL } from 'node:url'
import { createTerminal } from '@preventive/terminal'

const CORPUS = JSON.parse(readFileSync(new URL('./fixtures/source-tree-commands.json', import.meta.url), 'utf8'))

const SOURCES = { 'a.txt': 'A\n', 'dir/b.txt': 'B\n' }
const terminal = (opts = {}) => createTerminal(SOURCES, { mount: '/src', writable: '/tmp/', ...opts })
const parse = (line, opts) => terminal(opts).parse(line)
const named = (line, opts) => parse(line, opts).commands.map((c) => c.name)
const resolved = (line, opts) => parse(line, opts).commands.map((c) => c.resolved)
const verdict = (line, opts) => {
  const { ok, incomplete, error } = parse(line, opts)
  return { ok, incomplete, error }
}

describe('parse() reports the verdict on a line without running it', () => {
  it('describes a line that parses', () => {
    assert.deepEqual(terminal().parse('sort a.txt | uniq -c'), {
      ok: true,
      incomplete: false,
      error: null,
      commands: [{ name: 'sort', resolved: 'sort' }, { name: 'uniq', resolved: 'uniq' }],
      unsupported: [],
    })
  })

  for (const line of ['', '   ', '\n\n', '# just a comment', 'x=1', 'x=1 y=2', '> /tmp/out', '[[ -f a.txt ]]']) {
    it(`names no command in ${JSON.stringify(line)}`, () => {
      assert.deepEqual(verdict(line), { ok: true, incomplete: false, error: null })
      assert.deepEqual(named(line), [])
    })
  }

  it('freezes both lists and every command', () => {
    const result = terminal().parse('ls | grep x')
    assert.ok(Object.isFrozen(result.commands))
    assert.ok(Object.isFrozen(result.commands[0]))
    assert.ok(Object.isFrozen(result.unsupported))
  })
})

describe('parse() names the simple commands a line contains, in source order', () => {
  for (const [line, names] of [
    ['ls', ['ls']],
    ['ls -l | grep x | wc -l', ['ls', 'grep', 'wc']],
    ['echo a && cat a.txt || rm b', ['echo', 'cat', 'rm']],
    ['! grep -q x a.txt', ['grep']],
    ['x=1 ls; y=2 cat a.txt', ['ls', 'cat']],
    ['cat a.txt > /tmp/out 2>&1', ['cat']],
    ['{ ls; (cd dir && ls); }', ['ls', 'cd', 'ls']],
    ['for f in a b; do echo "$f"; cat "$f"; done', ['echo', 'cat']],
    ['if grep -q x a.txt; then head a.txt; else tail a.txt; fi', ['grep', 'head', 'tail']],
    ['if false; then ls; elif true; then cat a.txt; fi', ['false', 'ls', 'true', 'cat']],
    ['[[ -f a.txt ]] && wc -l a.txt', ['wc']],
    ['[ -f a.txt ] && wc -l a.txt', ['[', 'wc']],
    ['cat <<EOF | sort\nbody\nEOF', ['cat', 'sort']],
    ['ls\ncat a.txt\nwc -l a.txt', ['ls', 'cat', 'wc']],
  ]) {
    it(`names ${names.join(', ') || 'nothing'} in ${JSON.stringify(line)}`, () => {
      assert.deepEqual(named(line), names)
    })
  }

  it('descends into nested blocks in the order they are written', () => {
    const line = 'if ls; then for f in a; do { grep x; (sort); }; done; fi'
    assert.deepEqual(named(line), ['ls', 'grep', 'sort'])
  })

  // Which of them run is the gates' business; parsing only reads the line.
  for (const line of ['false && rm a.txt', 'true || rm a.txt', 'if false; then rm a.txt; fi', 'for f in; do rm a.txt; done']) {
    it(`names the command a gate will skip in ${JSON.stringify(line)}`, () => {
      assert.ok(named(line).includes('rm'))
    })
  }

  // A command named in argument position stays an argument.
  for (const [line, names] of [['xargs rm', ['xargs']], ['find . -exec rm {} +', ['find']], ['echo $(rm a.txt)', ['echo']], ['echo `rm a.txt`', ['echo']]]) {
    it(`names only ${names.join(', ')} in ${JSON.stringify(line)}`, () => {
      assert.deepEqual(named(line), names)
    })
  }
})

describe('parse() names a command only when quoting, not expansion, settles it', () => {
  for (const [line, name] of [
    ['ls', 'ls'],
    ['"ls"', 'ls'],
    ["l''s", 'ls'],
    ['\\ls', 'ls'],
    ["'$x'", '$x'],
    ["'*'", '*'],
    ['\\~x', '~x'],
    ['[ -f a.txt ]', '['],
    ['[abc x', '[abc'],
  ]) {
    it(`reads ${JSON.stringify(line)} as ${JSON.stringify(name)}`, () => {
      assert.deepEqual(named(line), [name])
    })
  }

  for (const line of ['$tool a', '${tool} a', '"$tool" a', '`which ls`', '$(which ls)', 'l$s', 'ls*', '?s', '[lc]s', '[a\\]b] x', '~/bin/tool', '{ls,cat}']) {
    it(`leaves ${JSON.stringify(line)} unnamed`, () => {
      assert.deepEqual(parse(line).commands, [{ name: null, resolved: null }])
    })
  }
})

describe('parse() resolves names against the terminal that would run them', () => {
  it('strips bin prefixes that reach a registered command', () => {
    assert.deepEqual(parse('/bin/ls | /usr/bin/grep x').commands, [
      { name: '/bin/ls', resolved: 'ls' },
      { name: '/usr/bin/grep', resolved: 'grep' },
    ])
  })

  for (const line of ['frobnicate', '/usr/bin/frobnicate', 'shopt -s nullglob', './ls', '/bin/cd']) {
    it(`resolves nothing for ${JSON.stringify(line)}`, () => {
      assert.deepEqual(resolved(line), [null])
      assert.equal(parse(line).ok, true)
    })
  }

  it('resolves wired commands like built-ins', () => {
    const opts = { commands: { sha256sum: () => '', quiet: { run: () => '', hidden: true } } }
    assert.deepEqual(resolved('sha256sum a.txt | quiet', opts), ['sha256sum', 'quiet'])
    assert.deepEqual(resolved('sha256sum a.txt'), [null])
  })

  it('agrees with what run() dispatches', () => {
    const t = terminal()
    for (const line of ['ls', '/bin/ls', 'frobnicate', '/bin/cd']) {
      const known = t.parse(line).commands[0].resolved !== null
      assert.equal(t.run(line).unsupported.length === 0, known, line)
    }
  })
})

describe('parse() reports a syntax error as run() would, and runs nothing', () => {
  for (const [line, error] of [
    ['echo )', 'unexpected `)`'],
    ['echo ;;', 'syntax error near unexpected token `;;`'],
    ['echo "', 'unterminated double quote'],
    ['echo $(cat', 'unterminated command substitution'],
    ['for 1 in a; do :; done', 'for: `1` is not a valid variable name'],
    ['echo a > ', 'redirect `>` requires a target'],
    ['} echo', 'syntax error near unexpected token `}`'],
  ]) {
    it(`reports ${JSON.stringify(error)} for ${JSON.stringify(line)}`, () => {
      assert.deepEqual(verdict(line), { ok: false, incomplete: false, error })
      assert.deepEqual(named(line), [])
      assert.equal(terminal().run(line).stderr, `error: ${error}\n`)
    })
  }
})

describe('parse() separates input it could still be handed more of', () => {
  for (const [line, error] of [
    ['(echo a', 'unmatched `(`'],
    ['{ echo a', 'unmatched `{`'],
    ['{ echo a;', 'unmatched `{`'],
    ['if true', 'if: missing `then`'],
    ['if true; then ls', 'if: missing `fi`'],
    ['if true; then ls; else', 'if: missing `fi`'],
    ['for f in a', 'for: missing `do`'],
    ['for f in a; do echo x', 'for: missing `done`'],
    ['ls &&', 'empty pipeline stage'],
    ['ls ||', 'empty pipeline stage'],
    ['ls |', 'empty pipeline stage'],
  ]) {
    it(`asks for more after ${JSON.stringify(line)}`, () => {
      assert.deepEqual(verdict(line), { ok: false, incomplete: true, error })
    })

    it(`finishes ${JSON.stringify(line)} once the rest arrives`, () => {
      const finished = { '(echo a': ')', '{ echo a': '; }', '{ echo a;': ' }', 'if true': '; then ls; fi', 'if true; then ls': '; fi', 'if true; then ls; else': ' cat a.txt; fi', 'for f in a': '; do ls; done', 'for f in a; do echo x': '; done', 'ls &&': ' cat a.txt', 'ls ||': ' cat a.txt', 'ls |': ' wc -l' }
      assert.deepEqual(verdict(line + finished[line]), { ok: true, incomplete: false, error: null })
    })
  }

  // A here-document body ends with the input, and a quote or substitution the
  // tokenizer never closed is the syntax error run() reports, not a prompt.
  for (const line of ['cat <<EOF', 'cat <<EOF\nbody', "echo '", 'echo `cat', 'echo ${x']) {
    it(`does not call ${JSON.stringify(line)} incomplete`, () => {
      assert.equal(parse(line).incomplete, false)
    })
  }

  it('keeps the commands of the units that parsed ahead of the error', () => {
    const result = parse('ls\ncat a.txt\nfor f in a; do')
    assert.deepEqual(result, {
      ok: false,
      incomplete: true,
      error: 'for: missing `done`',
      commands: [{ name: 'ls', resolved: 'ls' }, { name: 'cat', resolved: 'cat' }],
      unsupported: [],
    })
  })
})

describe('parse() reports the gaps parsing itself finds', () => {
  for (const line of [
    'while true; do :; done',
    'until false; do :; done',
    'case x in y) :;; esac',
    'echo $((1 + 1)) && ((x++))',
    'f() { :; }',
    'echo a & echo b',
    'echo ${x@Q}',
    'echo @(a|b)',
    'for ((i = 0; i < 3; i++)); do :; done',
    'x=(a b)',
    'echo a 3> /tmp/out',
  ]) {
    it(`matches run() on ${JSON.stringify(line)}`, () => {
      const parsed = terminal().parse(line)
      const run = terminal().run(line)
      assert.equal(parsed.ok, false)
      assert.deepEqual(parsed.unsupported, run.unsupported)
      assert.equal(run.stderr, `error: ${parsed.error}\n`)
    })
  }

  it('refuses a literal redirect target the filesystem would not accept', () => {
    const readOnly = createTerminal(SOURCES, { mount: '/src' })
    const parsed = readOnly.parse('echo a > out')
    assert.equal(parsed.ok, false)
    assert.deepEqual(parsed.unsupported, [{ kind: 'feature', command: null, detail: '>', message: '`>` cannot write to `out`: the filesystem is read-only' }])
    assert.deepEqual(readOnly.parse('echo a > /dev/null').unsupported, [])
  })

  // Dispatch, expansion and the commands themselves are never reached here.
  for (const line of ['frobnicate', 'ls --frobnicate', 'echo a > /etc/passwd', 'echo `while true; do :; done`', 'sed -e "s/a/b/w f" a.txt']) {
    it(`leaves ${JSON.stringify(line)} to run()`, () => {
      assert.deepEqual(parse(line).unsupported, [])
      assert.ok(terminal().run(line).unsupported.length > 0)
    })
  }
})

describe('parse() changes nothing', () => {
  it('leaves the working directory, variables and overlay alone', () => {
    const t = terminal()
    t.run('value=kept')
    const line = 'cd dir; value=changed; printf written > /tmp/file; rm a.txt'
    assert.equal(t.parse(line).ok, true)
    assert.equal(t.cwd(), '/src')
    assert.equal(t.run('printf "%s" "$value"').stdout, 'kept')
    assert.equal(t.run('test -e /tmp/file').exitCode, 1)
    assert.equal(t.run('test -e a.txt').exitCode, 0)
  })

  it('reads a line that would have ended the shell', () => {
    const t = terminal()
    assert.deepEqual(t.parse('exit 7').commands, [{ name: 'exit', resolved: 'exit' }])
    assert.equal(t.run('echo still here').stdout, 'still here\n')
  })

  it('reports the same verdict however often it is asked', () => {
    const t = terminal()
    const first = t.parse('for f in a; do cat "$f"; done')
    assert.deepEqual(t.parse('for f in a; do cat "$f"; done'), first)
    t.run('cd dir')
    assert.deepEqual(t.parse('for f in a; do cat "$f"; done'), first)
  })
})

// Every one of these runs over the real trees with an empty `unsupported`
// list, so a name parsing failed to settle, or resolved to nothing, would be
// this reading of the line falling short of what running it establishes.
describe('parse() settles every command in the source-analysis corpus', () => {
  for (const { id, purpose, command } of CORPUS) {
    it(`${id}. ${purpose}`, () => {
      const parsed = terminal().parse(command)
      assert.deepEqual({ ok: parsed.ok, error: parsed.error, unsupported: parsed.unsupported }, { ok: true, error: null, unsupported: [] }, command)
      assert.ok(parsed.commands.length > 0, command)
      for (const parsedCommand of parsed.commands) assert.equal(parsedCommand.resolved, parsedCommand.name, command)
    })
  }
})
