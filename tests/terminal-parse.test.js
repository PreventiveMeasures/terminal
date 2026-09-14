import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { URL } from 'node:url'
import { createTerminal } from '@preventive/terminal'

const CORPUS = JSON.parse(readFileSync(new URL('./fixtures/source-tree-commands.json', import.meta.url), 'utf8'))

const SOURCES = { 'a.txt': 'A\n', 'dir/b.txt': 'B\n' }
const terminal = (opts = {}) => createTerminal(SOURCES, { mount: '/src', writable: '/tmp/', ...opts })
const parse = (line, opts) => terminal(opts).parse(line)
const verdict = (line, opts) => {
  const { ok, incomplete, error } = parse(line, opts)
  return { ok, incomplete, error }
}

// A caller's walk over the tree, and the test's own check that the tree is
// enough to find what a line reaches for: every command, in source order.
function commandNames(result) {
  const out = []
  const walk = (steps) => {
    for (const step of steps) {
      for (const stage of step.stages) {
        if (stage.group) walk(stage.group)
        else if (stage.loop) walk(stage.loop.body)
        else if (stage.conditional) {
          for (const branch of stage.conditional.branches) { walk(branch.condition); walk(branch.body) }
          if (stage.conditional.otherwise) walk(stage.conditional.otherwise)
        } else if (stage.words.length > 0) out.push(stage.words[0].value)
      }
    }
  }
  for (const unit of result.units) walk(unit)
  return out
}

const named = (line, opts) => commandNames(parse(line, opts))

describe('parse() hands back the line as the parser read it', () => {
  it('describes a simple command', () => {
    assert.deepEqual(terminal().parse('wc -l a.txt'), {
      ok: true,
      incomplete: false,
      error: null,
      unsupported: [],
      units: [[{
        gate: 'first',
        negate: false,
        bang: false,
        stages: [{
          words: [{ value: 'wc', mask: null }, { value: '-l', mask: null }, { value: 'a.txt', mask: null }],
          assigns: [],
          redirs: [],
        }],
      }]],
    })
  })

  it('gates and pipes a chain, keeping source order', () => {
    const [unit] = parse('! ls | grep x && cat a.txt || rm b; true').units
    assert.deepEqual(unit.map((step) => [step.gate, step.negate, step.stages.length]), [
      ['first', true, 2], ['and', false, 1], ['or', false, 1], ['seq', false, 1],
    ])
    assert.deepEqual(named('! ls | grep x && cat a.txt || rm b; true'), ['ls', 'grep', 'cat', 'rm', 'true'])
  })

  it('keeps each line of a multi-line script as its own input unit', () => {
    const result = parse('ls\ncat a.txt')
    assert.equal(result.units.length, 2)
    assert.deepEqual(result.units.map((unit) => unit.length), [1, 1])
    assert.deepEqual(commandNames(result), ['ls', 'cat'])
  })

  it('separates a subshell from a brace group', () => {
    const [[step]] = parse('(cd dir) ; { cd dir; }').units.map((unit) => unit)
    assert.equal(step.stages[0].isolate, true)
    const second = parse('{ cd dir; }').units[0][0].stages[0]
    assert.equal(second.isolate, false)
    assert.equal(second.group.length, 1)
  })

  it("carries a loop's variable, its unexpanded list and its body", () => {
    const { loop } = parse('for f in *.js "$x"; do wc -l "$f"; done').units[0][0].stages[0]
    assert.equal(loop.name, 'f')
    assert.deepEqual(loop.words, [{ value: '*.js', mask: null }, { value: '${x}', mask: '2222' }])
    assert.deepEqual(commandNames({ units: [loop.body] }), ['wc'])
  })

  it('keeps an empty for list empty', () => {
    assert.deepEqual(parse('for f in; do ls; done').units[0][0].stages[0].loop.words, [])
  })

  it('orders if branches, each condition ahead of its body', () => {
    const { conditional } = parse('if ls; then cat a.txt; elif grep -q x a.txt; then head a.txt; else tail a.txt; fi').units[0][0].stages[0]
    assert.deepEqual(conditional.branches.map((b) => [commandNames({ units: [b.condition] }), commandNames({ units: [b.body] })]), [
      [['ls'], ['cat']], [['grep'], ['head']],
    ])
    assert.deepEqual(commandNames({ units: [conditional.otherwise] }), ['tail'])
    assert.equal(parse('if ls; then cat a.txt; fi').units[0][0].stages[0].conditional.otherwise, null)
  })

  it('reads [[ … ]] as an expression rather than a command', () => {
    const { test, words } = parse('[[ -f a.txt && "$x" == y ]]').units[0][0].stages[0]
    assert.deepEqual(words, [])
    assert.deepEqual(test, {
      kind: 'and',
      left: { kind: 'unary', op: '-f', word: { kind: 'word', value: 'a.txt', mask: null, quoted: false } },
      right: {
        kind: 'binary',
        op: '==',
        left: { kind: 'word', value: '${x}', mask: '2222', quoted: true },
        right: { kind: 'word', value: 'y', mask: null, quoted: false },
      },
    })
  })

  it('keeps assignments unexpanded, whether they stand alone or lead a command', () => {
    assert.deepEqual(parse('x=1 y=$z').units[0][0].stages[0], {
      words: [],
      assigns: [{ name: 'x', word: { value: '1', mask: null } }, { name: 'y', word: { value: '$z', mask: null } }],
      redirs: [],
    })
    const prefixed = parse('x=1 ls').units[0][0].stages[0]
    assert.deepEqual(prefixed.assigns.map((a) => a.name), ['x'])
    assert.deepEqual(prefixed.words.map((w) => w.value), ['ls'])
  })

  it('keeps quoting per character, and an expansion as its own source', () => {
    const words = parse('echo "a $x" \'$y\' "$(date)"').units[0][0].stages[0].words
    assert.deepEqual(words, [
      { value: 'echo', mask: null },
      { value: 'a ${x}', mask: '222222' },
      { value: '$y', mask: '11' },
      { value: '$(date)', mask: '2111111' },
    ])
  })

  it('keeps empty quoted fragments that expansion must not lose', () => {
    assert.deepEqual(parse('echo "$x"""').units[0][0].stages[0].words[1], { value: '${x}', mask: '2222', empty: [4] })
  })

  it('reads every redirect form, in source order', () => {
    const line = 'cat < a.txt > /tmp/out 2>> /tmp/log &> /tmp/both 2>&1 2>&- <<<here <<EOF\nbody\nEOF'
    assert.deepEqual(parse(line).units[0][0].stages[0].redirs, [
      { fd: 0, op: 'read', word: { value: 'a.txt', mask: null } },
      { fd: 1, op: 'to', target: '/tmp/out', both: false, append: false, label: '>' },
      { fd: 2, op: 'to', target: '/tmp/log', both: false, append: true, label: '2>>' },
      { fd: 1, op: 'to', target: '/tmp/both', both: true, append: false, label: '&>' },
      { fd: 2, op: 'dup', toFd: 1 },
      { fd: 2, op: 'close' },
      { fd: 0, op: 'herestring', word: { value: 'here', mask: null } },
      { fd: 0, op: 'text', body: 'body\n', expand: true },
    ])
  })

  it('marks a redirect target expansion has yet to settle', () => {
    assert.deepEqual(parse('echo a > $out').units[0][0].stages[0].redirs, [
      { fd: 1, op: 'to', word: { value: '$out', mask: null }, both: false, append: false, label: '>' },
    ])
  })

  it('leaves a quoted here-document body unexpanded', () => {
    assert.deepEqual(parse("cat <<'EOF'\n$x\nEOF").units[0][0].stages[0].redirs, [{ fd: 0, op: 'text', body: '$x\n', expand: false }])
  })

  it('warns about a here-document the input ended before its delimiter', () => {
    const [step] = parse('cat <<EOF\nbody').units[0]
    assert.match(step.warnings, /here-document delimited by end-of-file/u)
    assert.equal(parse('cat <<EOF\nbody\nEOF').units[0][0].warnings, undefined)
  })

  it('gives the caller a tree of its own, not shared state', () => {
    const t = terminal()
    const first = t.parse('wc -l a.txt')
    first.units[0][0].stages[0].words[1].value = '-c'
    assert.equal(t.parse('wc -l a.txt').units[0][0].stages[0].words[1].value, '-l')
    assert.equal(t.run('wc -l a.txt').stdout, '1 a.txt\n')
  })

  for (const line of ['', '   ', '\n\n', '# just a comment']) {
    it(`parses ${JSON.stringify(line)} as no units at all`, () => {
      assert.deepEqual(parse(line), { ok: true, incomplete: false, error: null, units: [], unsupported: [] })
    })
  }
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
      assert.deepEqual(parse(line).units, [])
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

  it('keeps the units that parsed ahead of the error', () => {
    const result = parse('ls\ncat a.txt\nfor f in a; do')
    assert.deepEqual(verdict('ls\ncat a.txt\nfor f in a; do'), { ok: false, incomplete: true, error: 'for: missing `done`' })
    assert.deepEqual(commandNames(result), ['ls', 'cat'])
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
    '[[ a =~ b ]]',
  ]) {
    it(`matches run() on ${JSON.stringify(line)}`, () => {
      const parsed = terminal().parse(line)
      const run = terminal().run(line)
      assert.equal(parsed.ok, false)
      assert.deepEqual(parsed.unsupported, run.unsupported)
      assert.equal(run.stderr, `error: ${parsed.error}\n`)
    })
  }

  // Dispatch, expansion and the commands themselves are never reached here.
  for (const line of ['frobnicate', 'ls --frobnicate', 'echo a > /etc/passwd', 'echo `while true; do :; done`', 'sed -e "s/a/b/w f" a.txt']) {
    it(`leaves ${JSON.stringify(line)} to run()`, () => {
      assert.deepEqual(parse(line).unsupported, [])
      assert.ok(terminal().run(line).unsupported.length > 0)
    })
  }

  it("applies the terminal's own write policy, as run() does", () => {
    const readOnly = createTerminal(SOURCES, { mount: '/src' })
    const parsed = readOnly.parse('echo a > out')
    assert.equal(parsed.ok, false)
    assert.deepEqual(parsed.unsupported, [{ kind: 'feature', command: null, detail: '>', message: '`>` cannot write to `out`: the filesystem is read-only' }])
    assert.deepEqual(readOnly.parse('echo a > /dev/null').unsupported, [])
    assert.equal(parse('echo a > /tmp/out').ok, true)
  })
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
    assert.deepEqual(commandNames(t.parse('exit 7')), ['exit'])
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
// list, so a line the parser could not read, or a tree its commands could not
// be walked out of, would be this reading falling short of running it.
describe('parse() settles every command in the source-analysis corpus', () => {
  for (const { id, purpose, command } of CORPUS) {
    it(`${id}. ${purpose}`, () => {
      const parsed = terminal().parse(command)
      assert.deepEqual({ ok: parsed.ok, error: parsed.error, unsupported: parsed.unsupported }, { ok: true, error: null, unsupported: [] }, command)
      const names = commandNames(parsed)
      assert.ok(names.length > 0, command)
      for (const name of names) assert.equal(terminal().run(`which ${name}`).exitCode, 0, `${command}: ${name}`)
    })
  }
})
