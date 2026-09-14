import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { URL, fileURLToPath } from 'node:url'
import { dirname, relative, resolve } from 'node:path'
import { createTerminal } from '@preventive/terminal'
import * as entry from '@preventive/terminal/parse.js'

const { parse } = entry
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// Static imports only: what loading the entry point actually costs.
function moduleGraph(entryPath) {
  const seen = new Set()
  const external = new Set()
  const stack = [resolve(ROOT, entryPath)]
  while (stack.length > 0) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const [, specifier] of readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)[^'"]*from\s*'([^']+)'/gmu)) {
      if (specifier.startsWith('.')) stack.push(resolve(dirname(file), specifier))
      else external.add(specifier)
    }
  }
  return { files: [...seen].map((file) => relative(ROOT, file)).sort(), external: [...external].sort() }
}

describe('the parse entry point is published on its own', () => {
  it('is exported as @preventive/terminal/parse.js, with its own types', () => {
    assert.deepEqual(pkg.exports['./parse.js'], { types: './src/parse.d.ts', default: './src/parse.js' })
    for (const file of ['src/parse.js', 'src/parse.d.ts', 'src/parse-tree.js']) assert.ok(pkg.files.includes(file), file)
  })

  it('exports the functions its types declare, and no more', () => {
    assert.deepEqual(Object.keys(entry).sort(), ['parse', 'summarize'])
    assert.equal(typeof parse, 'function')
  })

  it('loads the parser and nothing that runs a command', () => {
    const { files, external } = moduleGraph('src/parse.js')
    for (const file of files) {
      assert.doesNotMatch(file, /^src\/(commands|awk)\//u, file)
      assert.ok(!['src/index.js', 'src/registry.js', 'src/custom.js', 'src/fs.js', 'src/glob.js', 'src/mount.js', 'src/writable.js', 'src/complete.js', 'src/notes.js'].includes(file), file)
      assert.doesNotMatch(file, /^src\/shell\/(run|expand|state|io|output|capture|builtins|variables|arithmetic.*|conditional|parameter|parameter-pattern|parameter-transform)\.js$/u, file)
    }
    // A budget, not a target: the parser, its lexers, and the leaves they need
    // — brace syntax among them, since reading a word has to say which of its
    // text a `{a,b}` claims.
    assert.ok(files.length <= 17, `${files.length} modules: ${files.join(', ')}`)
    assert.deepEqual(external, ['@exodus/bytes/utf8.js'])
    assert.ok(moduleGraph('src/index.js').files.length > 80, 'the whole terminal is much more than the parser')
  })
})

describe('the parse entry point reads a line with no terminal at all', () => {
  it('reads a gated pipeline as commands, not as a low-level tree', () => {
    assert.deepEqual(parse('(echo 1 2> a; foo; bar -opt) | head -20 > x; ls'), {
      ok: true,
      incomplete: false,
      error: null,
      unsupported: [],
      list: [
        {
          type: 'pipeline',
          stages: [
            {
              type: 'subshell',
              list: [
                { type: 'command', argv: ['echo', '1'], redirects: [{ fd: 2, op: '>', target: 'a' }] },
                { type: 'command', op: ';', argv: ['foo'] },
                { type: 'command', op: ';', argv: ['bar', '-opt'] },
              ],
            },
            { type: 'command', argv: ['head', '-20'], redirects: [{ fd: 1, op: '>', target: 'x' }] },
          ],
        },
        { type: 'command', op: ';', argv: ['ls'] },
      ],
    })
  })

  // Where a line may write belongs to a terminal's filesystem, not to the line.
  for (const line of ['echo a > out', 'echo a > /etc/passwd', 'echo a >> dir/b.txt', 'cat a.txt > out 2> err']) {
    it(`reads rather than refuses ${JSON.stringify(line)}`, () => {
      assert.deepEqual(parse(line).unsupported, [])
      assert.equal(parse(line).ok, true)
      assert.equal(createTerminal({}).parse(line).ok, false, 'a read-only terminal still refuses it')
    })
  }

  it('names no command as unknown, having no commands to check against', () => {
    const result = parse('rg foo | wc -l')
    assert.equal(result.ok, true)
    assert.deepEqual(result.unsupported, [])
    assert.deepEqual(result.list[0].stages.map((stage) => stage.argv[0]), ['rg', 'wc'])
    assert.equal(createTerminal({}).run('rg foo | wc -l').unsupported[0].kind, 'command')
  })

  for (const line of [
    'ls -l | grep x',
    '! grep -q x a.txt && cat a.txt',
    'for f in *.js; do wc -l "$f"; done',
    'if [[ -f a ]]; then cat <<EOF\nbody\nEOF\nfi',
    '{ cd dir; (ls); }',
    "x=1 y='a b' printf '%s\\n' \"$x\"",
    'cat < a.txt 2>&1 | tr a-z A-Z',
    'echo $(date) `uname` ${x:-fallback} $((1 + 2))',
    'ls\ncat a.txt\n# comment',
    'echo )',
    'for f in a; do',
    'while true; do :; done',
    'echo ${x@Q}',
  ]) {
    it(`agrees with a terminal's own parse of ${JSON.stringify(line)}`, () => {
      assert.deepEqual(parse(line), createTerminal({}, { writable: '/tmp/', mount: '/src' }).parse(line))
    })
  }

  it('reports unfinished input, a syntax error and a refused construct apart', () => {
    assert.deepEqual(pick(parse('for f in a; do')), { ok: false, incomplete: true, error: 'for: missing `done`', gaps: [] })
    assert.deepEqual(pick(parse('echo )')), { ok: false, incomplete: false, error: 'unexpected `)`', gaps: [] })
    assert.deepEqual(pick(parse('while true; do :; done')), {
      ok: false,
      incomplete: false,
      error: '`while` loops are not supported; the only loop is `for NAME in WORD...; do LIST; done`',
      gaps: ['while'],
    })
  })

  it('keeps the commands that parsed ahead of an error', () => {
    const result = parse('ls\nfor f in a; do')
    assert.equal(result.ok, false)
    assert.deepEqual(result.list, [{ type: 'command', argv: ['ls'] }])
  })

  it('hands back a fresh tree each call, frozen only where a run is', () => {
    parse('ls -a').list[0].argv.push('extra')
    assert.deepEqual(parse('ls -a').list[0].argv, ['ls', '-a'])
    assert.ok(Object.isFrozen(parse('while :; do :; done').unsupported))
  })
})

const pick = (result) => ({ ok: result.ok, incomplete: result.incomplete, error: result.error, gaps: result.unsupported.map((gap) => gap.detail) })
