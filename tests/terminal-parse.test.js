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
    else if (node.type === 'subshell' || node.type === 'group') out.push(...commandNames(node.list))
    else if (node.type === 'for') out.push(...commandNames(node.list))
    else if (node.type === 'if') {
      for (const branch of node.branches) out.push(...commandNames(branch.condition), ...commandNames(branch.list))
      if (node.otherwise) out.push(...commandNames(node.otherwise))
    }
  }
  return out
}

const named = (line, opts) => commandNames(list(line, opts))
const parts = (...pieces) => pieces.length === 1 ? pieces[0] : { type: 'parts', parts: pieces }
const pattern = (source) => ({ type: 'pattern', pattern: source })
const home = () => ({ type: 'variable', name: 'HOME', quoted: true })

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
      { type: 'subshell', list: [{ type: 'command', argv: ['cd', 'dir'] }] },
      { type: 'group', op: ';', list: [{ type: 'command', argv: ['cd', 'dir'] }] },
    ])
  })

  // Brace expansion needs nothing but the text, and bash runs it first, so a
  // word list arrives with its braces already worked out.
  it('expands braces in a word list, and leaves alone what they are not', () => {
    assert.deepEqual(list('ls a{b,c} {1..3} a{b} "{a,b}"')[0].argv, ['ls', 'ab', 'ac', '1', '2', '3', 'a{b}', '{a,b}'])
    assert.deepEqual(list('ls ~/x{x,2}*')[0].argv, ['ls', parts(home(), pattern('/xx*')), parts(home(), pattern('/x2*'))])
    assert.deepEqual(list('for f in {1..3}; do ls; done')[0].words, ['1', '2', '3'])
  })

  // Only a word list multiplies: an assignment, a here-string and a `[[ … ]]`
  // operand take one word, and bash leaves their braces as text.
  it('leaves braces alone where the shell does not expand them', () => {
    assert.deepEqual(list('x={a,b} ls')[0].assignments, [{ name: 'x', value: '{a,b}' }])
    assert.deepEqual(list('cat <<< {a,b}')[0].redirects, [{ fd: 0, op: '<<<', text: '{a,b}' }])
    assert.deepEqual(list('[[ q == {a,b} ]]')[0].expression, { type: 'binary', op: '==', left: 'q', right: '{a,b}' })
  })

  // A redirect names one file, so a target that multiplies has nothing to say
  // for itself but what it was written as.
  it('keeps a redirect target that brace expansion would multiply', () => {
    assert.deepEqual(list('ls > {a,b}')[0].redirects, [{ fd: 1, op: '>', target: { type: 'brace', source: '{a,b}' } }])
    assert.deepEqual(list('ls > {1..1}')[0].redirects, [{ fd: 1, op: '>', target: '1' }])
    assert.equal(terminal().run('ls > {a,b}').stderr.trim(), 'error: {a,b}: ambiguous redirect')
  })

  it("carries a loop's variable, the words after `in` and the list it runs", () => {
    assert.deepEqual(list('for f in *.js a; do wc -l "$f"; done'), [{
      type: 'for',
      name: 'f',
      words: [pattern('*.js'), 'a'],
      list: [{ type: 'command', argv: ['wc', '-l', parts({ type: 'variable', name: 'f', quoted: true })] }],
    }])
    assert.deepEqual(list('for f in; do ls; done')[0].words, [])
  })

  it('orders if branches, each condition ahead of the list it guards', () => {
    const [node] = list('if ls; then cat a.txt; elif grep -q x a.txt; then head a.txt; else tail a.txt; fi')
    assert.deepEqual(node.branches.map((b) => [commandNames(b.condition), commandNames(b.list)]), [
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
        right: { type: 'binary', op: '==', left: parts({ type: 'variable', name: 'x', quoted: true }), right: 'y' },
      },
    }])
  })

  it('keeps assignments unexpanded, whether they stand alone or lead a command', () => {
    assert.deepEqual(list('x=1 y=$z'), [{
      type: 'command',
      argv: [],
      assignments: [{ name: 'x', value: '1' }, { name: 'y', value: parts({ type: 'variable', name: 'z', quoted: false }) }],
    }])
    assert.deepEqual(list('x=1 ls'), [{ type: 'command', argv: ['ls'], assignments: [{ name: 'x', value: '1' }] }])
  })

  it('reads every redirect form, in source order', () => {
    const line = 'cat < a.txt > /tmp/out 2>> /tmp/log &> /tmp/both 2>&1 2>&- <<<here <<EOF\nbody\nEOF'
    assert.deepEqual(list(line)[0].redirects, [
      { fd: 0, op: '<', target: 'a.txt' },
      { fd: 1, op: '>', target: '/tmp/out' },
      { fd: 2, op: '>>', target: '/tmp/log' },
      { fd: 1, op: '&>', target: '/tmp/both' },
      { fd: 2, op: '>&', toFd: 1 },
      { fd: 2, op: '>&-' },
      { fd: 0, op: '<<<', text: 'here' },
      { fd: 0, op: '<<', text: 'body\n', expand: true },
    ])
  })

  it('marks a redirect target expansion has yet to settle', () => {
    assert.deepEqual(list('echo a > $out')[0].redirects, [{ fd: 1, op: '>', target: parts({ type: 'variable', name: 'out', quoted: false }) }])
    assert.deepEqual(list("cat <<'EOF'\n$x\nEOF")[0].redirects, [{ fd: 0, op: '<<', text: '$x\n', expand: false }])
  })

  it('carries a block its own redirects', () => {
    assert.deepEqual(list('{ ls; } > /tmp/out'), [{
      type: 'group',
      list: [{ type: 'command', argv: ['ls'] }],
      redirects: [{ fd: 1, op: '>', target: '/tmp/out' }],
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
  for (const [written, value] of [
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
    it(`reads ${written} as the text ${JSON.stringify(value)}`, () => {
      assert.deepEqual(list(`echo ${written}`)[0].argv, ['echo', value])
    })
  }

  const dated = [{ type: 'command', argv: ['date'] }]
  for (const [written, pieces] of [
    ['$x', [{ type: 'variable', name: 'x', quoted: false }]],
    ['"$x"', [{ type: 'variable', name: 'x', quoted: true }]],
    ['${x:-a b}', [{ type: 'variable', name: 'x', operator: ':-', operand: 'a b', quoted: false }]],
    ['${#x}', [{ type: 'variable', name: 'x', operator: 'length', quoted: false }]],
    ['$?', [{ type: 'variable', name: '?', quoted: false }]],
    ['$(date)', [{ type: 'substitution', list: dated, quoted: false }]],
    ['"$(date)"', [{ type: 'substitution', list: dated, quoted: true }]],
    ['`date`', [{ type: 'substitution', list: dated, quoted: false }]],
    ['$((1 + 2))', [{ type: 'arithmetic', source: '1 + 2', quoted: false }]],
    ['*.js', [pattern('*.js')]],
    ['~', [home()]],
    ['~/bin', [home(), '/bin']],
    ['"$HOME/bin"', [home(), '/bin']],
    ['~/bin*', [home(), pattern('/bin*')]],
    ['~user/bin', ['~user/bin']],
    ["~''/bin", ['~/bin']],
    ['~"/bin"', ['~/bin']],
    ['a~b', ['a~b']],
    ['a{b}', ['a{b}']],
    ['[ab]c', [pattern('[ab]c')]],
    ['a*"b"', [pattern('a*'), 'b']],
    ['a"b"$c', ['ab', { type: 'variable', name: 'c', quoted: false }]],
    ['"$x"""', [{ type: 'variable', name: 'x', quoted: true }, '']],
    ['"a $x"', ['a ', { type: 'variable', name: 'x', quoted: true }]],
  ]) {
    it(`reads ${written} as the pieces expansion works on`, () => {
      assert.deepEqual(list(`echo ${written}`)[0].argv[1], parts(...pieces))
    })
  }

  it('reads the commands a substitution runs, however deep', () => {
    assert.deepEqual(list('foo `bar a b c`')[0].argv, ['foo', parts({ type: 'substitution', quoted: false, list: [{ type: 'command', argv: ['bar', 'a', 'b', 'c'] }] })])
    assert.deepEqual(list('echo $(cat $(ls))')[0].argv[1], parts({
      type: 'substitution',
      quoted: false,
      list: [{ type: 'command', argv: ['cat', parts({ type: 'substitution', quoted: false, list: [{ type: 'command', argv: ['ls'] }] })] }],
    }))
  })

  // Bash reads a backtick when it expands it, so the line still parses.
  it('keeps the diagnostic of a backtick body that does not parse', () => {
    assert.deepEqual(list('echo `echo )`')[0].argv[1], parts({ type: 'substitution', list: [], error: 'unexpected `)`', quoted: false }))
    assert.equal(parse('echo `echo )`').ok, true)
    assert.equal(parse('echo $(echo ))').ok, false)
  })

  it('applies the same rule to a command name', () => {
    assert.deepEqual(named('"ls"'), ['ls'])
    assert.deepEqual(named('$tool a'), [parts({ type: 'variable', name: 'tool', quoted: false })])
  })
})

describe('summarize() answers for a simple chain, and refuses the rest', () => {
  const CHAINS = [[['foo', '-bar'], ['head', '-10']], [['ls'], ['>', 'file.txt']]]

  for (const [line, summary] of [
    ['foo -bar | head -10; ls > file.txt', CHAINS],
    ['foo -bar | head -10\nls > file.txt', CHAINS],
    ['foo -bar | head -10 && ls > file.txt', [CHAINS[0], '&&', CHAINS[1]]],
    ['foo -bar | head -10 || ls > file.txt', [CHAINS[0], '||', CHAINS[1]]],
    ['a && b || c; d', [[['a']], '&&', [['b']], '||', [['c']], [['d']]]],
  ]) {
    it(`summarizes ${JSON.stringify(line)}`, () => {
      assert.deepEqual(terminal().summarize(line), summary)
    })
  }

  for (const [line, chains] of [
    ['ls', [[['ls']]]],
    ['ls -l a.txt', [[['ls', '-l', 'a.txt']]]],
    ['cat "a b" | wc -l', [[['cat', 'a b'], ['wc', '-l']]]],
    ['cat a 2> /tmp/err | tr a-z A-Z >> /tmp/out', [[['cat', 'a'], ['2>', '/tmp/err'], ['tr', 'a-z', 'A-Z'], ['>>', '/tmp/out']]]],
    ['wc < 1.txt || ls', [[['cat', '1.txt'], ['wc']], '||', [['ls']]]],
    ['wc -l < a.txt > /tmp/out', [[['cat', 'a.txt'], ['wc', '-l'], ['>', '/tmp/out']]]],
    ['cat 0< a.txt | tr a-z A-Z', [[['cat', 'a.txt'], ['tr', 'a-z', 'A-Z']]]],
    ['cat < a.txt', [[['cat', 'a.txt']]]],
    ['echo x | cat > /tmp/f', [[['echo', 'x'], ['>', '/tmp/f']]]],
    ['cat', [[['cat']]]],
    ['cat > /tmp/f', [[['cat'], ['>', '/tmp/f']]]],
    ['cat -n < a.txt', [[['cat', 'a.txt'], ['cat', '-n']]]],
    ['ls 2>&1 | grep x', [[['ls'], ['2>&1'], ['grep', 'x']]]],
    ['ls >&2', [[['ls'], ['>&2']]]],
    ['ls 2>&-', [[['ls'], ['2>&-']]]],
    ['ls &> /tmp/both', [[['ls'], ['&>', '/tmp/both']]]],
    ['', []],
    ['# comment', []],
  ]) {
    it(`summarizes ${JSON.stringify(line)}`, () => {
      assert.deepEqual(terminal().summarize(line), chains)
    })
  }

  for (const [line, message] of [
    ['(ls)', 'summarize: a subshell is not a simple chain'],
    ['{ ls; }', 'summarize: a brace group is not a simple chain'],
    ['for f in a; do ls; done', 'summarize: `for` is not a simple chain'],
    ['if ls; then cat a.txt; fi', 'summarize: `if` is not a simple chain'],
    ['[[ -f a.txt ]]', 'summarize: `[[ … ]]` is not a simple chain'],
    ['! ls', 'summarize: `!` is not a simple chain'],
    ['x=1 ls', 'summarize: an assignment is not a simple chain'],
    ['x=1', 'summarize: an assignment is not a simple chain'],
    ['> /tmp/out', 'summarize: a command with no name is not a simple chain'],
    ['cat <<EOF\n$x\nEOF', 'summarize: a here-document its delimiter leaves to expand is not a simple chain'],
    ['ls | wc < a.txt', 'summarize: a pipeline stage reading its own input is not a simple chain'],
    ['wc < a.txt < b.txt', 'summarize: a command reading from two places is not a simple chain'],
    ['wc < a.txt <<<here', 'summarize: a command reading from two places is not a simple chain'],
    ['ls > {a,b}', 'summarize: {a,b} is not a literal word'],
    ['ls a$(date)', 'summarize: $(…) is not a literal word'],
    ['echo `date`', 'summarize: $(…) is not a literal word'],
    ['echo $(date)', 'summarize: $(…) is not a literal word'],
    ['echo $((1 + 2))', 'summarize: $((…)) is not a literal word'],
    ['ls; (cd dir)', 'summarize: a subshell is not a simple chain'],
  ]) {
    it(`refuses ${JSON.stringify(line)}`, () => {
      assert.throws(() => terminal().summarize(line), { message })
    })
  }

  for (const [line, message] of [
    ['echo )', 'unexpected `)`'],
    ['for f in a; do', 'for: missing `done`'],
    ['while :; do :; done', '`while` loops are not supported; the only loop is `for NAME in WORD...; do LIST; done`'],
  ]) {
    it(`throws the parse diagnostic for ${JSON.stringify(line)}`, () => {
      assert.throws(() => terminal().summarize(line), { message })
    })
  }

  // `"$(cat <<'EOF' … EOF)"` is the text it holds, so that is what it says.
  const HERE = (body, delimiter = "'EOF'", quote = '"') => `echo ${quote}$(cat <<${delimiter}\n${body}\nEOF\n)${quote}`

  it('reads a quoted here-document substitution as the text it produces', () => {
    assert.deepEqual(terminal().summarize(HERE('multiline text\nover two lines')), [[['echo', 'multiline text\nover two lines']]])
    assert.deepEqual(terminal().summarize('echo "prefix $(cat <<\'EOF\'\nx\nEOF\n) suffix"'), [[['echo', 'prefix x suffix']]])
  })

  for (const [label, line] of [
    ['unquoted, so its text would split into fields', HERE('a b', "'EOF'", '')],
    ['a delimiter that lets the body expand', HERE('$x', 'EOF')],
    ['a cat that reads a file as well', 'echo "$(cat f <<\'EOF\'\nx\nEOF\n)"'],
    ['another command reading it', 'echo "$(wc <<\'EOF\'\nx\nEOF\n)"'],
    ['a second command after it', 'echo "$(cat <<\'EOF\'\nx\nEOF\nls)"'],
  ]) {
    it(`refuses ${label}`, () => {
      assert.throws(() => terminal().summarize(line), /is not a literal word/u)
    })
  }

  // Whatever feeds a command is the command that feeds it, and text is written
  // by the command that writes text.
  it('reads a here-document as the command that writes it', () => {
    assert.deepEqual(terminal().summarize('cat > /tmp/notes.md <<EOF\nhello\nEOF\n'), [[['echo', 'hello'], ['>', '/tmp/notes.md']]])
    assert.deepEqual(terminal().summarize("wc -l <<'EOF'\nline one\nline two\nEOF\n"), [[['echo', 'line one\nline two'], ['wc', '-l']]])
    assert.deepEqual(terminal().summarize('sort <<<here'), [[['echo', 'here'], ['sort']]])
  })

  // `echo` writes a newline of its own, and reads a leading `-` as an option,
  // so a body it would not say exactly is written by `printf` instead.
  it('writes with printf what echo would not say exactly', () => {
    assert.deepEqual(terminal().summarize('wc <<EOF\n-n\nEOF\n'), [[['printf', '%s', '-n\n'], ['wc']]])
    assert.deepEqual(terminal().summarize('cat <<EOF\nEOF\n'), [[['printf', '%s', '']]])
  })

  // A pattern says what it looks for as plainly as a name does, whether it is
  // the whole argument or one piece of a word joined from several.
  it('keeps a pattern, a variable and the word they join as what they are', () => {
    assert.deepEqual(terminal().summarize('ls *.js | head'), [[['ls', pattern('*.js')], ['head']]])
    assert.deepEqual(terminal().summarize('ls ~/bin'), [[['ls', parts(home(), '/bin')]]])
    assert.deepEqual(terminal().summarize('ls a*"b" a$x'), [[['ls', parts(pattern('a*'), 'b'), parts('a', { type: 'variable', name: 'x', quoted: false })]]])
    assert.deepEqual(terminal().summarize('ls $x "$y"'), [[['ls', { type: 'variable', name: 'x', quoted: false }, { type: 'variable', name: 'y', quoted: true }]]])
    assert.deepEqual(terminal().summarize('ls ${x:-a}'), [[['ls', { type: 'variable', name: 'x', operator: ':-', operand: 'a', quoted: false }]]])
    assert.deepEqual(terminal().summarize('echo a > $out'), [[['echo', 'a'], ['>', { type: 'variable', name: 'out', quoted: false }]]])
    assert.deepEqual(terminal().summarize('ls a{b,c} {1..3}'), [[['ls', 'ab', 'ac', '1', '2', '3']]])
    assert.deepEqual(terminal().summarize('wc < *.txt'), [[['cat', pattern('*.txt')], ['wc']]])
    assert.deepEqual(terminal().summarize('cat x > /tmp/out*'), [[['cat', 'x'], ['>', pattern('/tmp/out*')]]])
    assert.deepEqual(terminal().summarize('ls "*"'), [[['ls', '*']]])
  })

  it("refuses a write the terminal's filesystem would, as parse() does", () => {
    const readOnly = createTerminal(SOURCES, { mount: '/src' })
    assert.throws(() => readOnly.summarize('ls > out'), { message: '`>` cannot write to `out`: the filesystem is read-only' })
    assert.deepEqual(terminal().summarize('ls > /tmp/out'), [[['ls'], ['>', '/tmp/out']]])
  })

  it('runs none of it', () => {
    const t = terminal()
    assert.deepEqual(t.summarize('cd dir; printf x > /tmp/file'), [[['cd', 'dir']], [['printf', 'x'], ['>', '/tmp/file']]])
    assert.equal(t.cwd(), '/src')
    assert.equal(t.run('test -e /tmp/file').exitCode, 1)
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
