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

// The line a summary describes, written back out: a caller reading one is
// being told what to run, so the tokens have to go back together as a line
// that runs. Rows join with `|`, a redirect row attaches to the row before
// it, and a token that is not a plain word means this one cannot be written
// back — the summary is still right, it just holds more than text.
const REDIRECT = /^\d*(?:>>?|<|>&\d*|>&-|&>>?)$/u
const shellQuote = (t) => (/^[\w.,:/=@%+-]+$/u.test(t) ? t : `'${t.replaceAll("'", "'\\''")}'`)

function writtenBack(summary) {
  const parts = []
  for (const entry of summary) {
    if (typeof entry === 'string') { parts.push(entry); continue }
    const rows = []
    for (const row of entry) {
      if (!Array.isArray(row) || row.some((token) => typeof token !== 'string')) return null
      if (!REDIRECT.test(row[0])) { rows.push(row.map(shellQuote).join(' ')); continue }
      if (rows.length === 0) return null
      rows[rows.length - 1] += ' ' + [row[0], ...row.slice(1).map(shellQuote)].join(' ')
    }
    parts.push(rows.join(' | '))
  }
  return parts.map((part, i) => (i === 0 || part === '&&' || part === '||' || parts[i - 1] === '&&' || parts[i - 1] === '||' ? part : '; ' + part)).join(' ').replaceAll(' ; ', '; ')
}

const named = (line, opts) => commandNames(list(line, opts))
const parts = (...pieces) => pieces.length === 1 ? pieces[0] : { type: 'parts', parts: pieces }
const pattern = (source, multi = true) => ({ type: 'pattern', pattern: source, multi })
const home = () => ({ type: 'variable', name: 'HOME', multi: false })

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

  // `&` ends the list it follows rather than joining what comes next, so it
  // marks the command it ends and separates like `;` — and may end the line.
  it('marks what `&` hands to the background, and separates on it', () => {
    assert.deepEqual(list('ls & cat a.txt &'), [
      { type: 'command', background: true, argv: ['ls'] },
      { type: 'command', op: ';', background: true, argv: ['cat', 'a.txt'] },
    ])
    assert.deepEqual(list('ls | wc -l &'), [{ type: 'pipeline', background: true, stages: [{ type: 'command', argv: ['ls'] }, { type: 'command', argv: ['wc', '-l'] }] }])
    assert.deepEqual(list('ls && cat a.txt &').at(-1), { type: 'command', op: '&&', background: true, argv: ['cat', 'a.txt'] })
    assert.deepEqual(verdict('ls &'), { ok: true, incomplete: false, error: null })
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
      list: [{ type: 'command', argv: ['wc', '-l', parts({ type: 'variable', name: 'f', multi: false })] }],
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
        right: { type: 'binary', op: '==', left: parts({ type: 'variable', name: 'x', multi: false }), right: 'y' },
      },
    }])
  })

  it('keeps assignments unexpanded, whether they stand alone or lead a command', () => {
    assert.deepEqual(list('x=1 y=$z'), [{
      type: 'command',
      argv: [],
      assignments: [{ name: 'x', value: '1' }, { name: 'y', value: parts({ type: 'variable', name: 'z', multi: false }) }],
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
    assert.deepEqual(list('echo a > $out')[0].redirects, [{ fd: 1, op: '>', target: parts({ type: 'variable', name: 'out', multi: true }) }])
    // A target is its text only once nothing can change it: commands to run,
    // a path nothing has opened, and a reference behind an astral character
    // are all read rather than taken for the name of a file.
    assert.deepEqual(list('ls > `echo x`')[0].redirects[0].target, parts({ type: 'substitution', list: [{ type: 'command', argv: ['echo', 'x'] }], multi: true }))
    assert.deepEqual(list('ls > >(tee -a log)')[0].redirects[0].target, { type: 'process', op: '>', list: [{ type: 'command', argv: ['tee', '-a', 'log'] }] })
    assert.deepEqual(list("ls > '\u{1F600}'$x")[0].redirects[0].target, parts('\u{1F600}', { type: 'variable', name: 'x', multi: true }))
    assert.deepEqual(list('ls > /tmp/plain.txt')[0].redirects[0].target, '/tmp/plain.txt')
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
    ['$x', [{ type: 'variable', name: 'x', multi: true }]],
    ['"$x"', [{ type: 'variable', name: 'x', multi: false }]],
    ['${x:-a b}', [{ type: 'variable', name: 'x', operator: ':-', operand: 'a b', multi: true }]],
    ['${#x}', [{ type: 'variable', name: 'x', operator: 'length', multi: true }]],
    ['$?', [{ type: 'variable', name: '?', multi: true }]],
    ['$(date)', [{ type: 'substitution', list: dated, multi: true }]],
    ['"$(date)"', [{ type: 'substitution', list: dated, multi: false }]],
    ['`date`', [{ type: 'substitution', list: dated, multi: true }]],
    ['$((1 + 2))', [{ type: 'arithmetic', source: '1 + 2' }]],
    ['*.js', [pattern('*.js')]],
    ['~', [home()]],
    ['~/bin', [home(), '/bin']],
    ['"$HOME/bin"', [home(), '/bin']],
    ['~/bin*', [home(), pattern('/bin*')]],
    ['x=~/a', ['x=', home(), '/a']],
    ["~''/bin", ['~/bin']],
    ['~"/bin"', ['~/bin']],
    ['a~b', ['a~b']],
    ['a{b}', ['a{b}']],
    ['[ab]c', [pattern('[ab]c')]],
    ['a*"b"', [pattern('a*'), 'b']],
    ['a"b"$c', ['ab', { type: 'variable', name: 'c', multi: true }]],
    ['"$x"""', [{ type: 'variable', name: 'x', multi: false }, '']],
    ['"a $x"', ['a ', { type: 'variable', name: 'x', multi: false }]],
    ['${x##p}', [{ type: 'variable', name: 'x', operator: '##', operand: 'p', multi: true }]],
    ['${x/a/b}', [{ type: 'variable', name: 'x', operator: '/', operand: 'a/b', multi: true }]],
    ['${x:1:2}', [{ type: 'variable', name: 'x', operator: ':', operand: '1:2', multi: true }]],
    ['${x-}', [{ type: 'variable', name: 'x', operator: '-', operand: '', multi: true }]],
    ['${10}', [{ type: 'variable', name: '10', multi: true }]],
    ["$'a\\nb'", ['a\nb']],
    ['a$((1))b', ['a', { type: 'arithmetic', source: '1' }, 'b']],
    ['<(ls)', [{ type: 'process', op: '<', list: [{ type: 'command', argv: ['ls'] }] }]],
  ]) {
    it(`reads ${written} as the pieces expansion works on`, () => {
      assert.deepEqual(list(`echo ${written}`)[0].argv[1], parts(...pieces))
    })
  }

  // A function is a body that runs where its name is called, which is all one
  // can be while the body reads nothing of the call.
  it('reads a function definition as the body it names', () => {
    assert.deepEqual(list('f() { ls; }; f'), [
      { type: 'function', name: 'f', list: [{ type: 'command', argv: ['ls'] }] },
      { type: 'command', op: ';', argv: ['f'] },
    ])
    assert.deepEqual(verdict('f() { echo $x; }'), { ok: false, incomplete: false, error: '`f()` is supported only while its body reads and writes no variable' })
    assert.deepEqual(verdict('f() { x=1; }'), { ok: false, incomplete: false, error: '`f()` is supported only while its body reads and writes no variable' })
    assert.deepEqual(verdict('f() ( ls )'), { ok: false, incomplete: false, error: '`f()` needs a `{ … }` body' })
    assert.deepEqual(parse('f() { echo $x; }').unsupported.map((gap) => gap.detail), ['function'])
  })

  // `while LIST; do LIST; done` reads as the two lists it holds, and `until`
  // is the same loop with the question read the other way round.
  it('reads a while loop as the list it repeats and the list it asks', () => {
    assert.deepEqual(list('while a && b; do c; d; done'), [{
      type: 'while',
      condition: [{ type: 'command', argv: ['a'] }, { type: 'command', op: '&&', argv: ['b'] }],
      list: [{ type: 'command', argv: ['c'] }, { type: 'command', op: ';', argv: ['d'] }],
    }])
    assert.deepEqual(list('until a; do b; done')[0].type, 'until')
    assert.deepEqual(list('while a; do b; done > /tmp/out')[0].redirects, [{ fd: 1, op: '>', target: '/tmp/out' }])
    assert.deepEqual(verdict('while a; do b'), { ok: false, incomplete: true, error: 'while: missing `done`' })
    assert.deepEqual(verdict('until a; do b'), { ok: false, incomplete: true, error: 'until: missing `done`' })
    assert.deepEqual(verdict('while a'), { ok: false, incomplete: true, error: 'while: missing `do`' })
  })

  // `[[` opens a conditional only where a command may start, and is the plain
  // word it spells anywhere else — which is what a reading that finds one too
  // late would run instead. Command position outlives `&`, the reserved words
  // that lead a list rather than end one, and the `()` a definition opens with.
  it('reads `[[` as the conditional it is wherever a command may start', () => {
    const unary = { type: 'unary', op: '-f', word: 'x' }
    const AT = [
      ['while [[ -f x ]]; do b; done', (nodes) => nodes[0].condition[0]],
      ['until [[ -f x ]]; do b; done', (nodes) => nodes[0].condition[0]],
      ['while ! [[ -f x ]]; do b; done', (nodes) => nodes[0].condition[0]],
      ['until { [[ -f x ]]; }; do b; done', (nodes) => nodes[0].condition[0].list[0]],
      ['f() { [[ -f x ]]; }', (nodes) => nodes[0].list[0]],
      ['a & [[ -f x ]]', (nodes) => nodes[1]],
      ['{ [[ -f x ]]; }', (nodes) => nodes[0].list[0]],
      ['( [[ -f x ]] )', (nodes) => nodes[0].list[0]],
      ['for i in a; do [[ -f x ]]; done', (nodes) => nodes[0].list[0]],
      ['if a; then [[ -f x ]]; fi', (nodes) => nodes[0].branches[0].list[0]],
      ['a | [[ -f x ]]', (nodes) => nodes[0].stages[1]],
    ]
    for (const [line, at] of AT) {
      const node = at(list(line))
      assert.deepEqual([node.type, node.expression], ['test', unary], line)
    }
    // A word in any other place, as bash reads it: `echo until [[ x ]]` prints
    // its arguments, and quoting settles it wherever a conditional could open.
    assert.deepEqual(list('echo until [[ x ]]')[0].argv, ['echo', 'until', '[[', 'x', ']]'])
    assert.deepEqual(list('echo "[[" -f x "]]"')[0].argv, ['echo', '[[', '-f', 'x', ']]'])
    assert.deepEqual(verdict('{ a; } [[ -f x ]]'), { ok: false, incomplete: false, error: 'unexpected token after `}`' })
  })

  // A body holds its operands in an expression rather than a word list, and
  // the rule that keeps a call the same list as the line it stands in is asked
  // of them there: literal operands read nothing, and a reference is refused.
  it('reads a conditional in a function body, and refuses one that reads', () => {
    const body = (line) => list(line)[0].list[0]
    assert.deepEqual(body('f() { [[ -f x && -d y ]]; }').expression, {
      type: 'and',
      left: { type: 'unary', op: '-f', word: 'x' },
      right: { type: 'unary', op: '-d', word: 'y' },
    })
    assert.deepEqual(body('f() { [[ ! -f x ]]; }').expression, { type: 'not', expression: { type: 'unary', op: '-f', word: 'x' } })
    assert.deepEqual(body('f() { [[ -f x ]] > /tmp/o; }').redirects, [{ fd: 1, op: '>', target: '/tmp/o' }])
    const message = '`f()` is supported only while its body reads and writes no variable'
    for (const line of ['f() { [[ -f $x ]]; }', 'f() { [[ a == $b ]]; }', 'f() { [[ a == `x` ]]; }', 'f() { [[ ! -f $x ]]; }', 'f() { [[ -f x ]] > /tmp/$y; }']) {
      assert.deepEqual(verdict(line), { ok: false, incomplete: false, error: message }, line)
    }
    // The summary cannot say what a conditional answers, so it says so.
    assert.throws(() => terminal().summarize('f() { [[ -f x ]]; }; f'), { message: 'summarize: `[[ … ]]` is not a simple chain' })
  })

  // `<( … )` runs commands and the word is the path their output arrives on,
  // so what it holds is what it runs. Opening one needs a descriptor this
  // shell has none of, which is a gap running the line reports, not reading it.
  it('reads a process substitution as the commands it runs', () => {
    const process = (op, nodes) => ({ type: 'process', op, list: nodes })
    assert.deepEqual(list('cat <(ls)')[0].argv, ['cat', process('<', [{ type: 'command', argv: ['ls'] }])])
    assert.deepEqual(list('tee >(wc -l)')[0].argv, ['tee', process('>', [{ type: 'command', argv: ['wc', '-l'] }])])
    assert.deepEqual(list('diff <(a; b) <(c | d)')[0].argv.slice(1), [
      process('<', [{ type: 'command', argv: ['a'] }, { type: 'command', op: ';', argv: ['b'] }]),
      process('<', [{ type: 'pipeline', stages: [{ type: 'command', argv: ['c'] }, { type: 'command', argv: ['d'] }] }]),
    ])
    assert.deepEqual(list('echo <(ls) > /tmp/out')[0].redirects, [{ fd: 1, op: '>', target: '/tmp/out' }])
    // Quoting settles it as the text it spells, as it settles a pattern.
    assert.deepEqual(list('echo "<(ls)" \'<(ls)\'')[0].argv, ['echo', '<(ls)', '<(ls)'])
    assert.deepEqual(terminal().summarize('cat <(ls)'), [[['cat', { type: 'process', op: '<', summary: [[['ls']]] }]]])
  })

  // `>(` opens a process substitution wherever a word may start, and what
  // stands before it joins it: bash prints `2/dev/fd/63` for `echo 2>(cat)`,
  // which is the word `2` and the path, not a redirect of descriptor 2.
  it('joins a process substitution to the word it was written against', () => {
    const process = (op, nodes) => ({ type: 'process', op, list: nodes })
    const ran = [{ type: 'command', argv: ['cat'] }]
    assert.deepEqual(list('echo 2>(cat)')[0].argv[1], parts('2', process('>', ran)))
    assert.deepEqual(list('echo 1>(cat)')[0].argv[1], parts('1', process('>', ran)))
    assert.deepEqual(list('echo x>(cat)')[0].argv[1], parts('x', process('>', ran)))
    assert.deepEqual(list('cat 2<(ls)')[0].argv[1], parts('2', process('<', [{ type: 'command', argv: ['ls'] }])))
    // A space between them leaves two words, and a real descriptor redirect
    // still reads as one.
    assert.deepEqual(list('echo 2 >(cat)')[0].argv, ['echo', '2', process('>', ran)])
    assert.deepEqual(list('cat 2> /tmp/err')[0].redirects, [{ fd: 2, op: '>', target: '/tmp/err' }])
  })

  // Bash expands `~alice` to that user's home directory, and this shell has
  // no users to look one up in. Reading it as the text it is would answer a
  // question nobody asked, so a word holding one is refused where a syntax
  // error is — and, like one, leaves the commands ahead of it readable.
  it('refuses a tilde prefix that names anything but the home directory', () => {
    const message = 'named-user and directory-stack tilde prefixes are not supported'
    for (const line of ['ls ~user/bin', 'ls ~+', 'echo x=~-/a', 'echo $(ls ~user)', 'x=~user/a', 'cat < ~user/f']) {
      assert.deepEqual(verdict(line), { ok: false, incomplete: false, error: message }, line)
      assert.deepEqual(parse(line).unsupported, [{ kind: 'feature', command: null, detail: 'tilde prefix', message }], line)
    }
    assert.deepEqual(list('ls; ls ~user'), [{ type: 'command', argv: ['ls'] }])
  })

  // A prefix opens a word, and an assignment component after `=` or a `:`,
  // which is where bash expands one and so where the reading finds one.
  it('finds a tilde prefix everywhere bash expands one, and nowhere else', () => {
    assert.deepEqual(list('PATH=~/a:~/b ls')[0].assignments, [{ name: 'PATH', value: parts(home(), '/a:', home(), '/b') }])
    assert.deepEqual(list('echo a~b ~"/a" "~/a" x~/a')[0].argv, ['echo', 'a~b', '~/a', '~/a', 'x~/a'])
  })

  // Expansion happens in an assignment value, a here-string and a `[[ … ]]`
  // operand; splitting and matching do not. So a reference there is one word
  // however it was written, and a `*` is the text bash assigns rather than a
  // pattern — the one operand still matched being the pattern side of `==`.
  it('says what a slot the shell never splits does with a word', () => {
    assert.deepEqual(list('x=*.js y=$z ls')[0].assignments, [
      { name: 'x', value: '*.js' },
      { name: 'y', value: { type: 'variable', name: 'z', multi: false } },
    ])
    assert.deepEqual(list('cat <<< *.js')[0].redirects, [{ fd: 0, op: '<<<', text: '*.js' }])
    assert.deepEqual(list('cat <<< $x')[0].redirects, [{ fd: 0, op: '<<<', text: { type: 'variable', name: 'x', multi: false } }])
    assert.deepEqual(list('[[ -f *.js ]]')[0].expression, { type: 'unary', op: '-f', word: '*.js' })
    assert.deepEqual(list('[[ $x == *.js ]]')[0].expression, { type: 'binary', op: '==', left: { type: 'variable', name: 'x', multi: false }, right: pattern('*.js', false) })
    assert.deepEqual(list('ls *.js > out*')[0], { type: 'command', argv: ['ls', pattern('*.js')], redirects: [{ fd: 1, op: '>', target: pattern('out*') }] })
  })

  // The pattern side of `[[ x == y ]]` is the one slot that matches what it
  // does not split, so quoting there decides matching alone, and a reference
  // says which of the two it is where `multi` has nothing left to say.
  it('says whether a reference on the pattern side is matched or compared', () => {
    const right = (line) => list(line)[0].expression.right
    const variable = { type: 'variable', name: 'b', multi: false }
    assert.deepEqual(right('[[ a == $b ]]'), pattern(variable, false))
    assert.deepEqual(right('[[ a == "$b" ]]'), variable)
    assert.deepEqual(right('[[ a == x*$b ]]'), parts(pattern('x*', false), pattern(variable, false)))
    assert.deepEqual(right('[[ a != `x` ]]'), pattern({ type: 'substitution', list: [{ type: 'command', argv: ['x'] }], multi: false }, false))
    assert.deepEqual(right('[[ a == $((1+2)) ]]'), { type: 'arithmetic', source: '1+2' })
    assert.deepEqual(right('[[ a -eq $b ]]'), { type: 'variable', name: 'b', multi: false })
    assert.deepEqual(list('[[ -f $b ]]')[0].expression.word, { type: 'variable', name: 'b', multi: false })
    assert.deepEqual(list('ls a*')[0].argv[1], pattern('a*'))
    assert.throws(() => terminal().summarize('[[ a == $b ]]'), { message: 'summarize: `[[ … ]]` is not a simple chain' })
  })

  // Quotes settle how many words come back, and `"$@"` is the one they do not.
  it('says whether a reference may come back as more than one word', () => {
    assert.deepEqual(list('echo $x "$y" "$@" $@ "$*" $*')[0].argv.slice(1), [
      { type: 'variable', name: 'x', multi: true },
      { type: 'variable', name: 'y', multi: false },
      { type: 'variable', name: '@', multi: true },
      { type: 'variable', name: '@', multi: true },
      { type: 'variable', name: '*', multi: false },
      { type: 'variable', name: '*', multi: true },
    ])
  })

  it('reads the commands a substitution runs, however deep', () => {
    assert.deepEqual(list('foo `bar a b c`')[0].argv, ['foo', parts({ type: 'substitution', multi: true, list: [{ type: 'command', argv: ['bar', 'a', 'b', 'c'] }] })])
    assert.deepEqual(list('echo $(cat $(ls))')[0].argv[1], parts({
      type: 'substitution',
      multi: true,
      list: [{ type: 'command', argv: ['cat', parts({ type: 'substitution', multi: true, list: [{ type: 'command', argv: ['ls'] }] })] }],
    }))
  })

  // Bash reads a backtick when it expands it, so the line still parses.
  it('keeps the diagnostic of a backtick body that does not parse', () => {
    assert.deepEqual(list('echo `echo )`')[0].argv[1], parts({ type: 'substitution', list: [], error: 'unexpected `)`', multi: true }))
    assert.equal(parse('echo `echo )`').ok, true)
    assert.equal(parse('echo $(echo ))').ok, false)
  })

  it('applies the same rule to a command name', () => {
    assert.deepEqual(named('"ls"'), ['ls'])
    assert.deepEqual(named('$tool a'), [parts({ type: 'variable', name: 'tool', multi: true })])
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
    ['ls & ls &', [[['ls']], '&', [['ls']], '&']],
    ['ls & cat a.txt', [[['ls']], '&', [['cat', 'a.txt']]]],
    ['a && b &', [[['a']], '&&', [['b']], '&']],
    ['ls | wc -l > /tmp/out &', [[['ls'], ['wc', '-l'], ['>', '/tmp/out']], '&']],
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
    ['if ls; then cat a.txt; fi', 'summarize: `if` is not a simple chain'],
    ['[[ -f a.txt ]]', 'summarize: `[[ … ]]` is not a simple chain'],
    ['! ls', 'summarize: `!` is not a simple chain'],
    ['> /tmp/out', 'summarize: a command with no name is not a simple chain'],
    ['cat <<EOF\n$x\nEOF', 'summarize: a here-document its delimiter leaves to expand is not a simple chain'],
    ['ls | wc < a.txt', 'summarize: a pipeline stage reading its own input is not a simple chain'],
    ['wc < a.txt < b.txt', 'summarize: a command reading from two places is not a simple chain'],
    ['wc < a.txt <<<here', 'summarize: a command reading from two places is not a simple chain'],
    ['ls > {a,b}', 'summarize: {a,b} is not a literal word'],
    ['echo $(( $(id) + 1 ))', 'summarize: $((…)) is not a literal word'],
    ['echo ${x:-$(id)}', 'summarize: ${x:-$(id)} is not a literal word'],
    ['ls > ${x:-$(id)}', 'summarize: ${x:-$(id)} is not a literal word'],
    ['ls; if a; then b; fi', 'summarize: `if` is not a simple chain'],
  ]) {
    it(`refuses ${JSON.stringify(line)}`, () => {
      assert.throws(() => terminal().summarize(line), { message })
    })
  }

  for (const [line, message] of [
    ['echo )', 'unexpected `)`'],
    ['for f in a; do', 'for: missing `done`'],
    ['case x in a) :;; esac', '`case` statements are not supported; gate on exit status with `&&` / `||` instead'],
    ['ls ~user', 'named-user and directory-stack tilde prefixes are not supported'],
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

  // Only a here-document nothing else touches is the text it holds. The rest
  // is the shell it runs, which a summary says rather than refuses.
  const shell = (chains, multi) => ({ type: 'shell', summary: chains, multi })

  for (const [label, line, token] of [
    ['unquoted, so its text would split into fields', HERE('a b', "'EOF'", ''), shell([[['echo', 'a b']]], true)],
    ['a cat that reads a file as well', 'echo "$(cat f <<\'EOF\'\nx\nEOF\n)"', shell([[['echo', 'x'], ['cat', 'f']]], false)],
    ['another command reading it', 'echo "$(wc <<\'EOF\'\nx\nEOF\n)"', shell([[['echo', 'x'], ['wc']]], false)],
    ['a second command after it', 'echo "$(cat <<\'EOF\'\nx\nEOF\nls)"', shell([[['echo', 'x']], [['ls']]], false)],
  ]) {
    it(`says the shell it runs for ${label}`, () => {
      assert.deepEqual(terminal().summarize(line), [[['echo', token]]])
    })
  }

  it('refuses a delimiter that lets the body expand, inside a substitution as out', () => {
    assert.throws(() => terminal().summarize(HERE('$x', 'EOF')), { message: 'summarize: a here-document its delimiter leaves to expand is not a simple chain' })
  })

  // A substitution runs commands, and what a summary has to say about commands
  // is a summary. Quoting decides only whether its output stays one word.
  it('says the shell a word waits on, and how many words it may come back as', () => {
    assert.deepEqual(terminal().summarize('echo "`a;b`"'), [[['echo', shell([[['a']], [['b']]], false)]]])
    assert.deepEqual(terminal().summarize('echo `a;b`'), [[['echo', shell([[['a']], [['b']]], true)]]])
    assert.deepEqual(terminal().summarize('echo "`a|b`"'), [[['echo', shell([[['a'], ['b']]], false)]]])
    assert.deepEqual(terminal().summarize('echo `a|b`'), [[['echo', shell([[['a'], ['b']]], true)]]])
    assert.deepEqual(terminal().summarize('echo "`a`"'), [[['echo', shell([[['a']]], false)]]])
    assert.deepEqual(terminal().summarize('echo `a`'), [[['echo', shell([[['a']]], true)]]])
    assert.deepEqual(terminal().summarize('x=$(date) ls'), [[[{ type: 'assignments', assignments: [{ name: 'x', value: shell([[['date']]], false) }] }, 'ls']]])
    assert.deepEqual(terminal().summarize('ls $(cat f)/x'), [[['ls', parts(shell([[['cat', 'f']]], true), '/x')]]])
    assert.throws(() => terminal().summarize('echo `echo )`'), { message: 'unexpected `)`' })
  })

  // A definition runs nothing, so it says nothing; the body stands where the
  // name is called, and a body of one command reads as that command.
  it('stands a function where it is called, and says nothing where it is defined', () => {
    assert.deepEqual(terminal().summarize("bench() { wc -l a.txt; }; LABEL=after bench; ls; LABEL=before bench"), [
      [[{ type: 'assignments', assignments: [{ name: 'LABEL', value: 'after' }] }, 'wc', '-l', 'a.txt']],
      [['ls']],
      [[{ type: 'assignments', assignments: [{ name: 'LABEL', value: 'before' }] }, 'wc', '-l', 'a.txt']],
    ])
    assert.deepEqual(terminal().summarize('f() { ls; }'), [])
    assert.deepEqual(terminal().summarize('f() { ls; }; f | wc'), [[['ls'], ['wc']]])
    assert.deepEqual(terminal().summarize('f() { ls; }; f > /tmp/out'), [[['ls'], ['>', '/tmp/out']]])
    assert.deepEqual(terminal().summarize('f() { a; b; }; f | wc'), [[{ type: 'braces', summary: [[['a']], [['b']]] }, ['wc']]])
    assert.deepEqual(terminal().summarize('f() { date; }; echo "$(f)"'), [[['echo', { type: 'shell', summary: [[['date']]], multi: false }]]])
    assert.throws(() => terminal().summarize('f() { f; }; f'), { message: 'summarize: a function that calls itself is not a simple chain' })
    assert.throws(() => terminal().summarize('f() { ls; } | cat'), { message: 'summarize: a function defined in a pipeline is not a simple chain' })
  })

  // What a subshell defines belongs to it, so a summary must not stand a body
  // where a call of it would not have reached one — and a call inside a
  // subshell reaches the definitions the line around it made.
  it('keeps a definition inside the brackets that keep it', () => {
    assert.deepEqual(terminal().summarize('(f() { ls; }); f'), [[{ type: 'parens', summary: [] }], [['f']]])
    assert.deepEqual(terminal().summarize('f() { ls; }; (f)'), [[{ type: 'parens', summary: [[['ls']]] }]])
    // Parentheses a body would need keeping are kept: `f` is whatever it holds.
    assert.deepEqual(terminal().summarize('f() { cd dir; }; (f)'), [[{ type: 'parens', summary: [[['cd', 'dir']]] }]])
    assert.deepEqual(terminal().summarize('f() { cd dir; }; f'), [[['cd', 'dir']]])
  })

  // A call carries its own assignments, and a row that holds a list has
  // nowhere to put them: two calls that differ only there would read alike.
  it('keeps what a call sets, or says it cannot', () => {
    const set = { type: 'assignments', assignments: [{ name: 'X', value: '1' }] }
    assert.deepEqual(terminal().summarize('f() { ls; }; X=1 f'), [[[set, 'ls']]])
    assert.deepEqual(terminal().summarize('f() { ls; }; X=1 f > /tmp/o'), [[[set, 'ls'], ['>', '/tmp/o']]])
    assert.deepEqual(terminal().summarize('f() { a; b; }; f'), [[{ type: 'braces', summary: [[['a']], [['b']]] }]])
    const message = 'summarize: an assignment on a call of more than one command is not a simple chain'
    assert.throws(() => terminal().summarize('f() { a; b; }; X=1 f'), { message })
    assert.throws(() => terminal().summarize('f() { a; b; }; X=1 f > /tmp/o'), { message })
    // A definition behind a gate may never happen, so nothing may stand for it.
    for (const line of ['a && f() { ls; }', 'a || f() { ls; }']) {
      assert.throws(() => terminal().summarize(line), { message: 'summarize: a function defined behind a gate is not a simple chain' }, line)
    }
  })

  // Parentheses keep a command's directory, variables and exit to themselves,
  // so a command that changes one of those keeps the brackets that hold it in.
  it('drops brackets that keep nothing in, and keeps the rest', () => {
    for (const name of ['ls', 'echo hi', 'true', 'wc -l a.txt']) {
      assert.deepEqual(terminal().summarize(`(${name})`), [[name.split(' ')]], name)
    }
    for (const line of ['cd x', 'export X=1', 'unset X', 'eval x', 'read x', 'exit 1', 'source f']) {
      assert.deepEqual(terminal().summarize(`(${line})`), [[{ type: 'parens', summary: [[line.split(' ')]] }]], line)
    }
    // Braces keep nothing in, so they come off wherever parentheses would not.
    assert.deepEqual(terminal().summarize('{ cd x; }'), [[['cd', 'x']]])
    // An assignment is one of the things parentheses keep.
    assert.deepEqual(terminal().summarize('(X=1 ls)'), [[{
      type: 'parens',
      summary: [[[{ type: 'assignments', assignments: [{ name: 'X', value: '1' }] }, 'ls']]],
    }]])
  })

  // Whatever feeds a command is the command that feeds it, and where `echo`
  // would say something else than the text holds, `printf` says it exactly.
  it('writes the text a command is fed as the command that writes it', () => {
    assert.deepEqual(terminal().summarize("cat > /tmp/f <<'EOF'\nbody\nEOF"), [[['echo', 'body'], ['>', '/tmp/f']]])
    assert.deepEqual(terminal().summarize("cat > /tmp/f <<'EOF'\n-dash\nEOF"), [[['printf', '%s', '-dash\n'], ['>', '/tmp/f']]])
    assert.deepEqual(terminal().summarize("cat > /tmp/f <<'EOF'\na\nb\nEOF"), [[['echo', 'a\nb'], ['>', '/tmp/f']]])
    assert.deepEqual(terminal().summarize('cat <<< plain'), [[['echo', 'plain']]])
    assert.deepEqual(terminal().summarize('cat <<< -dash'), [[['printf', '%s', '-dash\n']]])
    assert.deepEqual(terminal().summarize('cat <<< $x'), [[['printf', '%s\\n', { type: 'variable', name: 'x', multi: false }]]])
    // A `cat` with nothing of its own passes what feeds it straight on.
    assert.deepEqual(terminal().summarize('echo x | cat > /tmp/f'), [[['echo', 'x'], ['>', '/tmp/f']]])
    assert.deepEqual(terminal().summarize('echo x | cat -n > /tmp/f'), [[['echo', 'x'], ['cat', '-n'], ['>', '/tmp/f']]])
  })

  // Every rewrite above is a claim that the line and the summary do the same
  // thing, so run both and hold it to that: what a caller reads back has to
  // leave the same output, status and directory behind as what they wrote.
  it('runs the same as the line it rewrote', () => {
    for (const [written, summarized] of [
      ['wc -l < a.txt', 'cat a.txt | wc -l'],
      ['cat < a.txt', 'cat a.txt'],
      ['cat -n < a.txt', 'cat a.txt | cat -n'],
      ["cat <<'EOF'\nbody\nEOF", 'echo body'],
      ["cat <<'EOF'\n-dash\nEOF", "printf '%s' '-dash\n'"],
      ["cat <<'EOF'\na\nb\nEOF", "echo 'a\nb'"],
      ['cat <<< plain', 'echo plain'],
      ['cat <<< -dash', "printf '%s' '-dash\n'"],
      ['echo x | cat', 'echo x'],
      ['echo x | cat > /tmp/f; cat /tmp/f', 'echo x > /tmp/f; cat /tmp/f'],
      ['(ls)', 'ls'],
      ['{ cd dir; }', 'cd dir'],
      ['f() { wc -l a.txt; }; f', 'wc -l a.txt'],
      ['f() { cat; }; echo fed | f', 'echo fed | cat'],
      ['for i in a b; do echo $i; done', 'echo a; echo b'],
    ]) {
      const one = terminal().run(written)
      const other = terminal().run(summarized)
      assert.deepEqual(
        [one.stdout, one.stderr, one.exitCode, one.cwd],
        [other.stdout, other.stderr, other.exitCode, other.cwd],
        written,
      )
    }
  })

  // A redirect is the tokens it was written with, and a descriptor it would
  // have defaulted to is left off the way a caller would write it again.
  it('writes a redirect back as the tokens it was written with', () => {
    for (const [line, tokens] of [
      ['ls > /tmp/a', ['>', '/tmp/a']],
      ['ls 1> /tmp/a', ['>', '/tmp/a']],
      ['ls >> /tmp/a', ['>>', '/tmp/a']],
      ['ls 2> /tmp/a', ['2>', '/tmp/a']],
      ['ls &> /tmp/a', ['&>', '/tmp/a']],
      ['ls &>> /tmp/a', ['&>>', '/tmp/a']],
      ['ls 2>&1', ['2>&1']],
      ['ls >&2', ['>&2']],
      ['ls 2>&-', ['2>&-']],
      ['ls >&-', ['>&-']],
    ]) {
      assert.deepEqual(terminal().summarize(line), [[['ls'], tokens]], line)
    }
  })

  // A `while` asks before every turn, and `until` reads the answer the other
  // way round. Both are a list run more than once, so both are a row.
  it('summarizes a while loop as the list it repeats and the list it asks', () => {
    assert.deepEqual(terminal().summarize('while test -e lock; do ls; done'), [[{
      type: 'while',
      condition: [[['test', '-e', 'lock']]],
      summary: [[['ls']]],
    }]])
    assert.deepEqual(terminal().summarize('until a; do b; done | wc'), [[
      { type: 'until', condition: [[['a']]], summary: [[['b']]] },
      ['wc'],
    ]])
  })

  // A `for` is a list of its own too, run once for each word after `in`.
  // `&` ends the row it follows rather than joining the next, and what that
  // row holds makes no difference to where it ends.
  it('closes a row on `&`, whatever the row holds', () => {
    const backgrounded = [
      ['ls &', [['ls']]],
      ['{ a; } &', [['a']]],
      ['(a) &', [['a']]],
      ['(cd dir) &', [{ type: 'parens', summary: [[['cd', 'dir']]] }]],
      ['{ a; b; } &', [{ type: 'braces', summary: [[['a']], [['b']]] }]],
      ['for i in a; do b; done &', [{ type: 'for', name: 'i', words: ['a'], summary: [[['b']]] }]],
      ['while a; do b; done &', [{ type: 'while', condition: [[['a']]], summary: [[['b']]] }]],
      ['until a; do b; done &', [{ type: 'until', condition: [[['a']]], summary: [[['b']]] }]],
      ['a | b &', [['a'], ['b']]],
    ]
    for (const [line, chain] of backgrounded) {
      assert.deepEqual(terminal().summarize(line), [chain, '&'], line)
    }
  })

  // A process substitution is a path the shell fills from what it runs, so the
  // word is the commands behind it wherever a word may stand.
  it('says what a process substitution runs, whichever slot holds it', () => {
    const process = (op, chains) => ({ type: 'process', op, summary: chains })
    assert.deepEqual(terminal().summarize('diff <(a) <(b)'), [[['diff', process('<', [[['a']]]), process('<', [[['b']]])]]])
    assert.deepEqual(terminal().summarize('ls > >(tee -a log)'), [[['ls'], ['>', process('>', [[['tee', '-a', 'log']]])]]])
    assert.deepEqual(terminal().summarize('cat < <(ls)'), [[['cat', process('<', [[['ls']]])]]])
    assert.deepEqual(terminal().summarize('tee >(wc -l) < a.txt'), [[['cat', 'a.txt'], ['tee', process('>', [[['wc', '-l']]])]]])
    assert.deepEqual(terminal().summarize('x=<(ls) ls'), [[[
      { type: 'assignments', assignments: [{ name: 'x', value: process('<', [[['ls']]]) }] },
      'ls',
    ]]])
  })

  // A row that holds a block holds whatever the block holds, however deep.
  it('nests a loop in the brackets that hold it', () => {
    const loop = { type: 'while', condition: [[['a']]], summary: [[['b']]] }
    assert.deepEqual(terminal().summarize('(while a; do b; done)'), [[{ type: 'parens', summary: [[loop]] }]])
    assert.deepEqual(terminal().summarize('f() { while a; do b; done; }; f'), [[{ type: 'braces', summary: [[loop]] }]])
    assert.deepEqual(terminal().summarize('until a; do b; done > /tmp/out'), [[{ ...loop, type: 'until' }, ['>', '/tmp/out']]])
    assert.deepEqual(terminal().summarize('{ for i in a b; do c; done; }'), [[{
      type: 'braces',
      summary: [[{ type: 'for', name: 'i', words: ['a', 'b'], summary: [[['c']]] }]],
    }]])
  })

  it('summarizes a for loop as the list it repeats', () => {
    assert.deepEqual(terminal().summarize('for d in a-*; do echo "$d"; done'), [[{
      type: 'for',
      name: 'd',
      words: [pattern('a-*')],
      summary: [[['echo', { type: 'variable', name: 'd', multi: false }]]],
    }]])
    assert.deepEqual(terminal().summarize('for f in {1..3}; do wc -l; done | sort'), [[
      { type: 'for', name: 'f', words: ['1', '2', '3'], summary: [[['wc', '-l']]] },
      ['sort'],
    ]])
    assert.deepEqual(terminal().summarize('for f in; do ls; done > /tmp/out'), [[
      { type: 'for', name: 'f', words: [], summary: [[['ls']]] },
      ['>', '/tmp/out'],
    ]])
    assert.throws(() => terminal().summarize('for f in a; do if a; then b; fi; done'), { message: 'summarize: `if` is not a simple chain' })
  })

  // `( … )` is a list of its own, and a summary of a list is a summary.
  it('summarizes a subshell as the line it runs, and drops what it keeps from nothing', () => {
    const parens = (chains) => ({ type: 'parens', summary: chains })
    assert.deepEqual(terminal().summarize('(ls)'), [[['ls']]])
    assert.deepEqual(terminal().summarize('(ls -a) | wc'), [[['ls', '-a'], ['wc']]])
    assert.deepEqual(terminal().summarize('(ls) > /tmp/out'), [[['ls'], ['>', '/tmp/out']]])
    assert.deepEqual(terminal().summarize('echo x | (cat) > /tmp/f'), [[['echo', 'x'], ['>', '/tmp/f']]])
    assert.deepEqual(terminal().summarize('(cd dir; ls)'), [[parens([[['cd', 'dir']], [['ls']]])]])
    assert.deepEqual(terminal().summarize('(cd dir)'), [[parens([[['cd', 'dir']]])]])
    assert.deepEqual(terminal().summarize('(a && b &)'), [[parens([[['a']], '&&', [['b']], '&'])]])
    assert.deepEqual(terminal().summarize('(ls; cd x) | wc -l > /tmp/out'), [[parens([[['ls']], [['cd', 'x']]]), ['wc', '-l'], ['>', '/tmp/out']]])
    assert.deepEqual(terminal().summarize('(ls > /tmp/a) > /tmp/b'), [[parens([[['ls'], ['>', '/tmp/a']]]), ['>', '/tmp/b']]])
    assert.deepEqual(terminal().summarize('(x=1)'), [[parens([[[{ type: 'assignments', assignments: [{ name: 'x', value: '1' }] }]]])]])
  })

  // `{ …; }` is the same list, run where it stands rather than beside it —
  // which is the one thing the brackets decide, and all they are told apart by.
  it('summarizes a brace group as the line it runs, in the shell it runs in', () => {
    const braces = (chains) => ({ type: 'braces', summary: chains })
    assert.deepEqual(terminal().summarize('a || { b; c; }'), [[['a']], '||', [braces([[['b']], [['c']]])]])
    assert.deepEqual(terminal().summarize('{ cd dir; ls; }'), [[braces([[['cd', 'dir']], [['ls']]])]])
    assert.deepEqual(terminal().summarize('{ a | b; } > /tmp/out'), [[braces([[['a'], ['b']]]), ['>', '/tmp/out']]])
    // Braces keep nothing to itself, so one command inside is that command —
    // where parentheses keep the `cd` they hold, and stay.
    assert.deepEqual(terminal().summarize('{ ls; }'), [[['ls']]])
    assert.deepEqual(terminal().summarize('{ cd dir; }'), [[['cd', 'dir']]])
    assert.deepEqual(terminal().summarize('{ ls; } > /tmp/out'), [[['ls'], ['>', '/tmp/out']]])
    assert.deepEqual(terminal().summarize('{ ls > /tmp/a; } > /tmp/b'), [[braces([[['ls'], ['>', '/tmp/a']]]), ['>', '/tmp/b']]])
  })

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
    assert.deepEqual(terminal().summarize('ls a*"b" a$x'), [[['ls', parts(pattern('a*'), 'b'), parts('a', { type: 'variable', name: 'x', multi: true })]]])
    assert.deepEqual(terminal().summarize('ls $x "$y"'), [[['ls', { type: 'variable', name: 'x', multi: true }, { type: 'variable', name: 'y', multi: false }]]])
    assert.deepEqual(terminal().summarize('ls ${x:-a}'), [[['ls', { type: 'variable', name: 'x', operator: ':-', operand: 'a', multi: true }]]])
    // An operand is text, and text is all it may hold: `${x:-$y}` reads a
    // name in front of a reader, where `${x:-$(id)}` would run `id` behind one.
    assert.deepEqual(terminal().summarize('ls ${x:-$y}'), [[['ls', { type: 'variable', name: 'x', operator: ':-', operand: '$y', multi: true }]]])
    // A sum is an expression, said as it was written, under the same rule.
    assert.deepEqual(terminal().summarize('echo $((1 + 2)) $((i++))'), [[['echo', { type: 'arithmetic', source: '1 + 2' }, { type: 'arithmetic', source: 'i++' }]]])
    assert.deepEqual(terminal().summarize('x=$((n * 2)) ls'), [[[{ type: 'assignments', assignments: [{ name: 'x', value: { type: 'arithmetic', source: 'n * 2' } }] }, 'ls']]])
    assert.deepEqual(terminal().summarize('echo a > $out'), [[['echo', 'a'], ['>', { type: 'variable', name: 'out', multi: true }]]])
    assert.deepEqual(terminal().summarize('ls a{b,c} {1..3}'), [[['ls', 'ab', 'ac', '1', '2', '3']]])
    assert.deepEqual(terminal().summarize('wc < *.txt'), [[['cat', pattern('*.txt')], ['wc']]])
    assert.deepEqual(terminal().summarize('cat x > /tmp/out*'), [[['cat', 'x'], ['>', pattern('/tmp/out*')]]])
    assert.deepEqual(terminal().summarize('ls "*"'), [[['ls', '*']]])
  })

  // `A=1 cmd` sets them for that command and `A=1` on its own sets them for
  // the shell, so they stand at the head of the row, where they were written.
  it('keeps the assignments a command carries, in front of its name', () => {
    const assigned = (...assignments) => ({ type: 'assignments', assignments })
    assert.deepEqual(terminal().summarize('A=1 B=2 ls -l'), [[[assigned({ name: 'A', value: '1' }, { name: 'B', value: '2' }), 'ls', '-l']]])
    assert.deepEqual(terminal().summarize('x=1; y=2'), [[[assigned({ name: 'x', value: '1' })]], [[assigned({ name: 'y', value: '2' })]]])
    assert.deepEqual(terminal().summarize('x=1 > /tmp/out'), [[[assigned({ name: 'x', value: '1' })], ['>', '/tmp/out']]])
    assert.deepEqual(terminal().summarize('A=1 ls | B=2 wc'), [[[assigned({ name: 'A', value: '1' }), 'ls'], [assigned({ name: 'B', value: '2' }), 'wc']]])
    assert.deepEqual(terminal().summarize('x=*.js y=~/a ls'), [[[assigned({ name: 'x', value: '*.js' }, { name: 'y', value: parts(home(), '/a') }), 'ls']]])
    assert.throws(() => terminal().summarize('x=${y:-$(id)} ls'), { message: 'summarize: ${y:-$(id)} is not a literal word' })
  })

  // A here-string is its word and a newline, whoever settles the word.
  it('feeds a here-string as the command that writes it', () => {
    assert.deepEqual(terminal().summarize('wc <<< *.js'), [[['echo', '*.js'], ['wc']]])
    assert.deepEqual(terminal().summarize('wc <<< $x'), [[['printf', '%s\\n', { type: 'variable', name: 'x', multi: false }], ['wc']]])
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
    // A block ends where its closer does, and bash rejects a word after one.
    // A definition ends on its `}` like a group, and so rejects one too —
    // `f() { ls; } ls` is a syntax error, not a definition with `ls` dropped.
    ['f() { ls; } ls', 'unexpected token after `}`'],
    ['f() { echo hi; } echo bye', 'unexpected token after `}`'],
    ['{ ls; } ls', 'unexpected token after `}`'],
    ['( ls ) ls', 'unexpected token after `)`'],
    ['while false; do ls; done ls', 'unexpected token after `done`'],
    ['until false; do ls; done ls', 'unexpected token after `done`'],
    ['if true; then ls; fi ls', 'unexpected token after `fi`'],
    ['ls ; ; ls', 'empty pipeline stage'],
    ['a & & b', 'empty pipeline stage'],
    ['(ls)(ls)', 'unexpected `(`'],
    ['until a; do b; done; done', 'unexpected `done`'],
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
    ['while true', 'while: missing `do`'],
    ['while true; do ls', 'while: missing `done`'],
    ['until true', 'until: missing `do`'],
    ['until true; do ls', 'until: missing `done`'],
    ['f() {', 'unmatched `{`'],
    ['f() { ls;', 'unmatched `{`'],
    ['ls &&', 'empty pipeline stage'],
    ['ls ||', 'empty pipeline stage'],
    ['ls |', 'empty pipeline stage'],
  ]) {
    it(`asks for more after ${JSON.stringify(line)}`, () => {
      assert.deepEqual(verdict(line), { ok: false, incomplete: true, error })
    })

    it(`finishes ${JSON.stringify(line)} once the rest arrives`, () => {
      const finished = { '(echo a': ')', '{ echo a': '; }', '{ echo a;': ' }', 'if true': '; then ls; fi', 'if true; then ls': '; fi', 'if true; then ls; else': ' cat a.txt; fi', 'for f in a': '; do ls; done', 'for f in a; do echo x': '; done', 'ls &&': ' cat a.txt', 'ls ||': ' cat a.txt', 'ls |': ' wc -l', 'while true': '; do ls; done', 'while true; do ls': '; done', 'until true': '; do ls; done', 'until true; do ls': '; done', 'f() {': ' ls; }', 'f() { ls;': ' }' }
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
    'case x in y) :;; esac',
    'echo $((1 + 1)) && ((x++))',
    'f() { echo $x; }',
    'echo ${x@Q}',
    'echo ~x',
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

  // Reading `&` is bash's grammar, which the parser has. Handing a list to
  // the background is the terminal's, which has nowhere to put one.
  it('reads `&` and leaves the backgrounding to run()', () => {
    const result = parse('echo a & echo b')
    assert.deepEqual({ ok: result.ok, unsupported: result.unsupported }, { ok: true, unsupported: [] })
    assert.deepEqual(result.list, [
      { type: 'command', background: true, argv: ['echo', 'a'] },
      { type: 'command', op: ';', argv: ['echo', 'b'] },
    ])
    assert.deepEqual(terminal().run('echo a & echo b').unsupported, [
      { kind: 'feature', command: null, detail: '&', message: 'background processes (`&`) are not supported' },
    ])
  })

  // Dispatch, expansion and the commands themselves are never reached here.
  for (const line of ['frobnicate', 'ls --frobnicate', 'echo a > /etc/passwd', 'echo `while true; do :; done`', 'sed -e "s/a/b/w f" a.txt', 'cat <(ls)']) {
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

  // A definition read is not a definition made: reading a line that would
  // name a body leaves the shell with no name it did not already have.
  it('defines nothing by reading a definition', () => {
    const t = terminal()
    t.parse('bench() { ls; }; bench')
    t.summarize('other() { ls; }; other')
    assert.deepEqual(t.complete('be'), [])
    assert.deepEqual(t.complete('oth'), [])
    for (const name of ['bench', 'other']) {
      const r = t.run(name)
      assert.equal(r.exitCode, 127, name)
      assert.deepEqual(r.unsupported.map((gap) => gap.detail), [name], name)
    }
  })

  // The summary of a line is read the same way the tree is, so it changes as
  // little: a loop it summarizes runs no turn, and a `cd` moves nothing.
  it('runs none of a line it summarizes either', () => {
    const t = terminal()
    t.run('value=kept')
    assert.deepEqual(t.summarize('cd dir; value=changed; rm a.txt'), [
      [['cd', 'dir']],
      [[{ type: 'assignments', assignments: [{ name: 'value', value: 'changed' }] }]],
      [['rm', 'a.txt']],
    ])
    t.summarize('while true; do rm a.txt; done')
    t.summarize('for f in a.txt; do rm "$f"; done')
    assert.equal(t.cwd(), '/src')
    assert.equal(t.run('printf "%s" "$value"').stdout, 'kept')
    assert.equal(t.run('test -e a.txt').exitCode, 0)
  })
})

// Every one of these runs over the real trees with an empty `unsupported`
// list, so a line the parser could not read, or a command whose name reading
// the tree could not settle, would be this falling short of running it.
describe('summarize() says what the line it read would do', () => {
  // A summary is a claim: run what it describes and the line it describes,
  // and the two leave the same output, status and directory behind. Every
  // corpus command that reads back as plain tokens is held to that.
  it('runs each corpus command the way its summary says', () => {
    let checked = 0
    for (const { command } of CORPUS) {
      let summary
      try { summary = terminal().summarize(command) } catch { continue }
      const rebuilt = writtenBack(summary)
      if (rebuilt === null) continue
      checked++
      const written = terminal().run(command)
      const said = terminal().run(rebuilt)
      assert.deepEqual(
        [said.stdout, said.exitCode, said.cwd],
        [written.stdout, written.exitCode, written.cwd],
        `${command}\n  \u2192 ${rebuilt}`,
      )
    }
    assert.ok(checked >= 40, `only ${checked} of ${CORPUS.length} corpus commands read back as plain tokens`)
  })

  // The corpus is mostly pipelines, so hold the gates, the sequences and the
  // redirects to the same claim on lines written for them.
  for (const [command, expected] of [
    ['ls && cat a.txt', 'ls && cat a.txt'],
    ['ls || cat a.txt', 'ls || cat a.txt'],
    ['ls; cat a.txt', 'ls; cat a.txt'],
    ['false && ls || cat a.txt', 'false && ls || cat a.txt'],
    ['wc -l < a.txt', 'cat a.txt | wc -l'],
    ['wc -l < a.txt > /tmp/out', 'cat a.txt | wc -l > /tmp/out'],
    ['cat a.txt 2> /tmp/err | tr a-z A-Z >> /tmp/out', 'cat a.txt 2> /tmp/err | tr a-z A-Z >> /tmp/out'],
    ['ls 2>&1 | grep x', 'ls 2>&1 | grep x'],
    ['echo x | cat > /tmp/f', 'echo x > /tmp/f'],
    ["cat <<'EOF'\nbody\nEOF", 'echo body'],
    ['cat <<< here', 'echo here'],
    ['(ls) && { cat a.txt; }', 'ls && cat a.txt'],
    ['f() { wc -l a.txt; }; f && ls', 'wc -l a.txt && ls'],
    ["echo 'a b' | cat", "echo 'a b'"],
    ["echo 'a b' | cat -n", "echo 'a b' | cat -n"],
  ]) {
    it(`writes ${JSON.stringify(command)} back as the line it runs`, () => {
      const rebuilt = writtenBack(terminal().summarize(command))
      assert.equal(rebuilt, expected)
      const written = terminal().run(command)
      const said = terminal().run(rebuilt)
      assert.deepEqual([said.stdout, said.stderr, said.exitCode, said.cwd], [written.stdout, written.stderr, written.exitCode, written.cwd])
    })
  }
})

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
