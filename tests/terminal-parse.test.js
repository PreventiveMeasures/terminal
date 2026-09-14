import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { URL } from 'node:url'
import { createTerminal } from '@preventive/terminal'

const CORPUS = JSON.parse(readFileSync(new URL('./fixtures/source-tree-commands.json', import.meta.url), 'utf8'))

const SOURCES = { 'a.txt': 'A\n', 'dir/b.txt': 'B\n' }
const terminal = (opts = {}) => createTerminal(SOURCES, { mount: '/src', writable: '/tmp/', ...opts })
const parse = (line, opts) => terminal(opts).parse(line)
const list = (line, opts) => parse(line, opts).list
const verdict = (line, opts) => {
  const { ok, incomplete, error } = parse(line, opts)
  return { ok, incomplete, error }
}

// A caller's walk over the tree, and the test's own check that reading what a
// line reaches for takes no knowledge of quoting: every command name, in order.
function commandNames(nodes) {
  const out = []
  for (const node of nodes) {
    if (node.type === 'command') { if (node.argv.length > 0) out.push(node.argv[0]) }
    else if (node.type === 'pipeline') out.push(...commandNames(node.stages))
    else if (node.type === 'subshell' || node.type === 'group') out.push(...commandNames(node.body))
    else if (node.type === 'for') out.push(...commandNames(node.body))
    else if (node.type === 'if') {
      for (const branch of node.branches) out.push(...commandNames(branch.condition), ...commandNames(branch.body))
      if (node.otherwise) out.push(...commandNames(node.otherwise))
    }
  }
  return out
}

const named = (line, opts) => commandNames(list(line, opts))

describe('parse() hands back the line as the parser read it', () => {
  it('describes a simple command as its argv', () => {
    assert.deepEqual(terminal().parse('wc -l a.txt'), {
      ok: true,
      incomplete: false,
      error: null,
      unsupported: [],
      list: [{ type: 'command', argv: ['wc', '-l', 'a.txt'] }],
    })
  })

  it('joins commands with the operator that was written', () => {
    assert.deepEqual(list('ls && cat a.txt || rm b; true'), [
      { type: 'command', argv: ['ls'] },
      { type: 'command', op: '&&', argv: ['cat', 'a.txt'] },
      { type: 'command', op: '||', argv: ['rm', 'b'] },
      { type: 'command', op: ';', argv: ['true'] },
    ])
  })

  it('reads a newline as the separator it is, in one list', () => {
    assert.deepEqual(list('ls\ncat a.txt\n# comment\nwc -l a.txt'), [
      { type: 'command', argv: ['ls'] },
      { type: 'command', op: ';', argv: ['cat', 'a.txt'] },
      { type: 'command', op: ';', argv: ['wc', '-l', 'a.txt'] },
    ])
  })

  it('keeps a pipeline only when there is more than one stage', () => {
    assert.deepEqual(list('! ls | grep x'), [{
      type: 'pipeline',
      negate: true,
      stages: [{ type: 'command', argv: ['ls'] }, { type: 'command', argv: ['grep', 'x'] }],
    }])
    assert.deepEqual(list('! ls'), [{ type: 'command', negate: true, argv: ['ls'] }])
  })

  it('separates a subshell from a brace group', () => {
    assert.deepEqual(list('(cd dir) ; { cd dir; }'), [
      { type: 'subshell', body: [{ type: 'command', argv: ['cd', 'dir'] }] },
      { type: 'group', op: ';', body: [{ type: 'command', argv: ['cd', 'dir'] }] },
    ])
  })

  it("carries a loop's variable, its unexpanded list and its body", () => {
    assert.deepEqual(list('for f in *.js a; do wc -l "$f"; done'), [{
      type: 'for',
      name: 'f',
      words: [{ type: 'word', value: '*.js' }, 'a'],
      body: [{ type: 'command', argv: ['wc', '-l', { type: 'word', value: '${f}', mask: '2222' }] }],
    }])
    assert.deepEqual(list('for f in; do ls; done')[0].words, [])
  })

  it('orders if branches, each condition ahead of its body', () => {
    const [node] = list('if ls; then cat a.txt; elif grep -q x a.txt; then head a.txt; else tail a.txt; fi')
    assert.deepEqual(node.branches.map((b) => [commandNames(b.condition), commandNames(b.body)]), [
      [['ls'], ['cat']], [['grep'], ['head']],
    ])
    assert.deepEqual(commandNames(node.otherwise), ['tail'])
    assert.equal(list('if ls; then cat a.txt; fi')[0].otherwise, undefined)
  })

  it('reads [[ … ]] as an expression rather than a command', () => {
    assert.deepEqual(list('[[ ! -f a.txt && "$x" == y ]]'), [{
      type: 'test',
      expression: {
        type: 'and',
        left: { type: 'not', expression: { type: 'unary', op: '-f', word: 'a.txt' } },
        right: { type: 'binary', op: '==', left: { type: 'word', value: '${x}', mask: '2222' }, right: 'y' },
      },
    }])
  })

  it('keeps assignments unexpanded, whether they stand alone or lead a command', () => {
    assert.deepEqual(list('x=1 y=$z'), [{
      type: 'command',
      argv: [],
      assigns: [{ name: 'x', value: '1' }, { name: 'y', value: { type: 'word', value: '$z' } }],
    }])
    assert.deepEqual(list('x=1 ls'), [{ type: 'command', argv: ['ls'], assigns: [{ name: 'x', value: '1' }] }])
  })

  it('reads every redirect form, in source order', () => {
    const line = 'cat < a.txt > /tmp/out 2>> /tmp/log &> /tmp/both 2>&1 2>&- <<<here <<EOF\nbody\nEOF'
    assert.deepEqual(list(line)[0].redirs, [
      { fd: 0, op: '<', target: 'a.txt' },
      { fd: 1, op: '>', target: '/tmp/out' },
      { fd: 2, op: '>>', target: '/tmp/log' },
      { fd: 1, op: '&>', target: '/tmp/both' },
      { fd: 2, op: '>&', toFd: 1 },
      { fd: 2, op: '>&-' },
      { fd: 0, op: '<<<', text: 'here' },
      { fd: 0, op: '<<', body: 'body\n', expand: true },
    ])
  })

  it('marks a redirect target expansion has yet to settle', () => {
    assert.deepEqual(list('echo a > $out')[0].redirs, [{ fd: 1, op: '>', target: { type: 'word', value: '$out' } }])
    assert.deepEqual(list("cat <<'EOF'\n$x\nEOF")[0].redirs, [{ fd: 0, op: '<<', body: '$x\n', expand: false }])
  })

  it('carries a block its own redirects', () => {
    assert.deepEqual(list('{ ls; } > /tmp/out'), [{
      type: 'group',
      body: [{ type: 'command', argv: ['ls'] }],
      redirs: [{ fd: 1, op: '>', target: '/tmp/out' }],
    }])
  })

  it('warns about a here-document the input ended before its delimiter', () => {
    assert.match(list('cat <<EOF\nbody')[0].warnings, /here-document delimited by end-of-file/u)
    assert.equal(list('cat <<EOF\nbody\nEOF')[0].warnings, undefined)
  })

  it('gives the caller a tree of its own, not shared state', () => {
    const t = terminal()
    t.parse('wc -l a.txt').list[0].argv[1] = '-c'
    assert.deepEqual(t.parse('wc -l a.txt').list[0].argv, ['wc', '-l', 'a.txt'])
    assert.equal(t.run('wc -l a.txt').stdout, '1 a.txt\n')
  })

  for (const line of ['', '   ', '\n\n', '# just a comment']) {
    it(`parses ${JSON.stringify(line)} as an empty list`, () => {
      assert.deepEqual(parse(line), { ok: true, incomplete: false, error: null, list: [], unsupported: [] })
    })
  }
})

describe('parse() spells a value out only when expansion still decides it', () => {
  for (const [word, value] of [
    ['ls', 'ls'],
    ['"a b"', 'a b'],
    ["l''s", 'ls'],
    ['\\ls', 'ls'],
    ["'$x'", '$x'],
    ["'*'", '*'],
    ['""', ''],
    ['[', '['],
    ['a=b', 'a=b'],
  ]) {
    it(`reads ${word} as the text ${JSON.stringify(value)}`, () => {
      assert.deepEqual(list(`echo ${word}`)[0].argv, ['echo', value])
    })
  }

  for (const [word, node] of [
    ['$x', { type: 'word', value: '$x' }],
    ['"$x"', { type: 'word', value: '${x}', mask: '2222' }],
    ['$(date)', { type: 'word', value: '$(date)', mask: '0111111' }],
    ['"$(date)"', { type: 'word', value: '$(date)', mask: '2111111' }],
    ['`date`', { type: 'word', value: '`date`', mask: '011111' }],
    ['*.js', { type: 'word', value: '*.js' }],
    ['~/bin', { type: 'word', value: '~/bin' }],
    ['{a,b}', { type: 'word', value: '{a,b}' }],
    ['[ab]c', { type: 'word', value: '[ab]c' }],
    ['"$x"""', { type: 'word', value: '${x}', mask: '2222', empty: [4] }],
  ]) {
    it(`keeps ${word} as a word`, () => {
      assert.deepEqual(list(`echo ${word}`)[0].argv[1], node)
    })
  }

  it('applies the same rule to a command name', () => {
    assert.deepEqual(named('"ls"'), ['ls'])
    assert.deepEqual(named('$tool a'), [{ type: 'word', value: '$tool' }])
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
      assert.deepEqual(list(line), [])
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

  it('keeps the commands that parsed ahead of the error', () => {
    assert.deepEqual(verdict('ls\ncat a.txt\nfor f in a; do'), { ok: false, incomplete: true, error: 'for: missing `done`' })
    assert.deepEqual(named('ls\ncat a.txt\nfor f in a; do'), ['ls', 'cat'])
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
    assert.deepEqual(commandNames(t.parse('exit 7').list), ['exit'])
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
// list, so a line the parser could not read, or a command whose name reading
// the tree could not settle, would be this falling short of running it.
describe('parse() settles every command in the source-analysis corpus', () => {
  for (const { id, purpose, command } of CORPUS) {
    it(`${id}. ${purpose}`, () => {
      const parsed = terminal().parse(command)
      assert.deepEqual({ ok: parsed.ok, error: parsed.error, unsupported: parsed.unsupported }, { ok: true, error: null, unsupported: [] }, command)
      const names = commandNames(parsed.list)
      assert.ok(names.length > 0, command)
      for (const name of names) {
        assert.equal(typeof name, 'string', `${command}: ${JSON.stringify(name)}`)
        assert.equal(terminal().run(`which ${name}`).exitCode, 0, `${command}: ${name}`)
      }
    })
  }
})
