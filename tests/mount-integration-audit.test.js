import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import { createTerminal } from '@preventive/terminal'

function check(t, command, stdout, cwd = t.cwd()) {
  assert.deepEqual(t.run(command), { stdout, stderr: '', exitCode: 0, cwd, unsupported: [] }, command)
}

const options = { mount: '/work [x]', cwd: '/work [x]', home: '/work [x]/home', writable: '/tmp/' }
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"
const argsCommand = ({ args }) => JSON.stringify(args)

// Bash general.c: bash_tilde_find_word rejects any quoted portion before the
// first slash, including empty quotes; subst.c checks the original word start.
// https://www.gnu.org/software/bash/manual/html_node/Tilde-Expansion.html
// https://raw.githubusercontent.com/gitGNU/gnu_bash/master/general.c
describe('mounted home expansion respects empty quoted fragments', () => {
  for (const operand of ["''~", '""~', "~''", '~""', "''~/note", '""~/note', "~''/note", '~""/note', '~user""/note', '~u"ser"/note', String.raw`~u\ser/note`]) {
    it(operand, () => {
      const t = createTerminal({}, options)
      const expected = operand.replaceAll("'", '').replaceAll('"', '').replaceAll('\\', '')
      check(t, `printf '%s\\n' ${operand}`, expected + '\n')
    })
  }

  for (const assignment of ["X=''~", 'X=""~', "X=~''", 'X=~""', "X=left:''~/note", "X=left:~''/note"]) {
    it(assignment, () => {
      const t = createTerminal({}, options)
      const expected = assignment.slice(2).replaceAll("'", '').replaceAll('"', '')
      check(t, `${assignment}; printf '%s\\n' "$X"`, expected + '\n')
    })
  }

  it('expands only unquoted assignment components', () => {
    const t = createTerminal({}, options)
    check(t, 'X=""~:~/:~""; printf "%s\\n" "$X"', '~:/work [x]/home/:~\n')
    check(t, 'export X=""~:~/:~""; printf "%s\\n" "$X"', '~:/work [x]/home/:~\n')
  })

  it('keeps an empty quoted filename fragment after the first slash valid', () => {
    const t = createTerminal({ 'home/note': 'home\n', '~/note': 'literal\n' }, options)
    check(t, `cat ~/''note; cat ''~/note; cat ~''/note`, 'home\nliteral\nliteral\n')
    check(t, 'HOME=/tmp; printf "%s\\n" ~ ""~ ~"" ~/""note', '/tmp\n~\n~\n/tmp/note\n')
  })
})

describe('mounted sources and custom filesystem views remain isolated', () => {
  it('accepts a Map from another JavaScript realm without losing every file', () => {
    const sources = runInNewContext('new Map([["../file", "content"], ["/dir/child", "child"]])')
    assert.equal(sources instanceof Map, false)
    const t = createTerminal(sources, options)
    check(t, 'cat file dir/child', 'contentchild')
    check(t, 'find . -type f', './dir/child\n./file\n')
  })

  for (const map of [false, true]) {
    it(`snapshots ${map ? 'Map' : 'object'} sources without merging writable files`, () => {
      const entries = [['file', 'original'], ['dir/child', 'child']]
      const sources = map ? new Map(entries) : Object.fromEntries(entries)
      const t = createTerminal(sources, options)
      if (map) { sources.set('file', 'changed'); sources.set('added', 'new'); sources.delete('dir/child') }
      else { sources.file = 'changed'; sources.added = 'new'; delete sources['dir/child'] }
      check(t, 'cat file dir/child; printf overlay >/tmp/file; cat /tmp/file', 'originalchildoverlay')
      check(t, 'ls', 'dir\nfile\n')
      assert.deepEqual(map ? [...sources] : Object.entries(sources), [['file', 'changed'], ['added', 'new']])
    })
  }

  it('treats an object source named entries as a file, not a Map iterator', () => {
    check(createTerminal({ entries: 'file', 'dir/leaf': 'leaf' }, options), 'cat entries dir/leaf', 'fileleaf')
  })

  it('does not expose cached source or writable directory arrays to a handler', () => {
    const sources = { file: 'source', 'dir/leaf': 'leaf' }
    const t = createTerminal(sources, {
      ...options,
      commands: {
        mutate: ({ fs }) => {
          for (const path of ['.', '/tmp']) {
            const listing = fs.listDir(path)
            listing.dirs.push('injected')
            listing.files.length = 0
            listing.files.push('fake')
            fs.walkFiles(path).splice(0, 100, '/fake')
          }
        },
        listing: ({ fs }) => JSON.stringify(fs.listDir('/tmp')),
      },
    })
    check(t, 'printf writable >/tmp/file; mutate; cat file /tmp/file', 'sourcewritable')
    check(t, 'ls; ls /tmp', 'dir\nfile\nfile\n')
    check(t, 'find . /tmp -type f', './dir/leaf\n./file\n/tmp/file\n')
    check(t, "printf '%s\\n' ./* /tmp/*", './dir\n./file\n/tmp/file\n')
    assert.deepEqual(t.complete('cat /tmp/f'), ['cat /tmp/file'])
    check(t, 'listing', '{"dirs":[],"files":["file"]}')
    check(t, 'rm /tmp/file; listing', '{"dirs":[],"files":[]}')
    assert.deepEqual(sources, { file: 'source', 'dir/leaf': 'leaf' })
  })

  for (const [path, error] of [['file/../dir', 'not a directory'], ['file/', 'not a directory'], ['missing/../dir', 'no such file or directory']]) {
    it(`custom fs.listDir retains the lookup error for ${path}`, () => {
      const t = createTerminal({ file: 'file', 'dir/leaf': 'leaf' }, {
        ...options, commands: { listing: ({ fs, args }) => { fs.listDir(args[0]) } },
      })
      assert.deepEqual(t.run(`listing ${path}`), {
        stdout: '', stderr: `listing: ${path}: ${error}\n`, exitCode: 1, cwd: options.cwd, unsupported: [],
      })
      assert.deepEqual(t.complete(`cat ${path}/l`), [])
    })
  }

  for (const value of [null, false, 12, {}, '/bad\0path']) {
    it(`validates cwd ${JSON.stringify(value)} before filesystem lookup`, () => {
      assert.throws(() => createTerminal({}, { cwd: value }), /cwd must be a string without NUL/u)
    })
  }

  for (const sources of [{ 'bad\0path': 'content' }, new Map([['bad\0path', 'content']])]) {
    it('rejects an inaccessible source filename containing NUL', () => {
      assert.throws(() => createTerminal(sources, options), /source paths must not contain NUL/u)
    })
  }
})

describe('completion preserves literal mounted filenames and typed prefixes', () => {
  const names = [
    'space name', 'semi;echo wrong', 'pipe|name', 'amp&name', 'or||name', 'and&&name',
    'left(name', 'right)name', 'quote\'name', 'double"name', 'back\\name',
    'dollar$name', 'tick`name', 'glob[name]', 'star*name', 'question?name',
    'brace{name}', 'hash#name', '#leading', '~literal', '-n', '-',
    'line\nname', 'tab\tname', 'cr\rname', 'wide\u2003name', 'astral😀name',
  ]
  const fixture = () => createTerminal(Object.fromEntries(names.map((name) => [name, name])), {
    ...options, commands: { args: argsCommand },
  })

  for (const name of names) {
    it(`produces an executable completion for ${JSON.stringify(name)}`, () => {
      const t = fixture()
      const suggestions = t.complete('args ')
      const selected = suggestions.filter((line) => t.run(line).stdout === JSON.stringify([name.startsWith('-') ? './' + name : name]))
      assert.equal(selected.length, 1, name)
      assert.ok(selected[0].startsWith('args '))
      check(t, selected[0], JSON.stringify([name.startsWith('-') ? './' + name : name]))
      check(t, 'cat ' + selected[0].slice('args '.length), name)
    })
  }

  for (const [prefix, name] of [
    ['args spa', 'space name'], [String.raw`args space\ n`, 'space name'],
    ["args 'space n", 'space name'], ['args "space n', 'space name'],
    ["args 'spa'", 'space name'], ['args "spa"', 'space name'],
    [String.raw`args semi\;e`, 'semi;echo wrong'], ["args 'semi;e", 'semi;echo wrong'],
    [String.raw`args pipe\|n`, 'pipe|name'], ['args "pipe|n', 'pipe|name'],
    [String.raw`args glob\[n`, 'glob[name]'], ["args 'glob[n", 'glob[name]'],
    [String.raw`args dollar\$n`, 'dollar$name'], ["args 'dollar$n", 'dollar$name'],
    [String.raw`args quote\'n`, "quote'name"], ["args 'quote", "quote'name"],
    ['args "double', 'double"name'], [String.raw`args "back\\n`, 'back\\name'],
    ['args "line\nn', 'line\nname'], ['args cr\rn', 'cr\rname'], ['args wide\u2003n', 'wide\u2003name'],
  ]) {
    it(`retains the prefix ${JSON.stringify(prefix)}`, () => {
      const t = fixture()
      const suggestions = t.complete(prefix)
      assert.equal(suggestions.length, 1)
      assert.ok(suggestions[0].startsWith(prefix), suggestions[0])
      check(t, suggestions[0], JSON.stringify([name]))
    })
  }

  it('does not reinterpret quoted previous operands as command boundaries', () => {
    const t = fixture()
    for (const prior of ['literal|pipe', 'literal;semi', 'literal\nnewline', 'literal(and)', 'literal&&and']) {
      const prefix = `args ${quote(prior)} spa`
      const suggestions = t.complete(prefix)
      assert.equal(suggestions.length, 1, prefix)
      check(t, suggestions[0], JSON.stringify([prior, 'space name']))
    }
  })

  it('allows quoted and escaped command names while retaining pipe restrictions', () => {
    const t = fixture()
    assert.deepEqual(t.complete("'gre"), ["'grep'"])
    assert.deepEqual(t.complete(String.raw`g\re`), [String.raw`g\rep`])
    assert.deepEqual(t.complete('cat|"gre'), ['cat|"grep"'])
    assert.deepEqual(t.complete('cat|"grep" spa'), [])
    assert.deepEqual(t.complete('cat|gre'), ['cat|grep'])
  })

  it('completes quoted cd operands as directories and protects odd path components', () => {
    const t = createTerminal({ 'dir [a];/leaf name': 'leaf', 'dir file': 'file' }, options)
    const prefix = "'cd' 'dir "
    assert.deepEqual(t.complete(prefix), ["'cd' 'dir [a];/'"])
    check(t, t.complete(prefix)[0], '', '/work [x]/dir [a];')
    const command = t.complete('cat leaf')[0]
    check(t, command, 'leaf')
  })

  it('distinguishes literal tildes from the configured home in completion', () => {
    const t = createTerminal({ 'home/note': 'home', '~/note': 'literal', '~user/note': 'user' }, options)
    for (const prefix of ["cat '~/n", 'cat "~/n', String.raw`cat \~/n`, "cat ''~/n", "cat ~''/n"]) {
      const suggestions = t.complete(prefix)
      assert.equal(suggestions.length, 1, prefix)
      assert.ok(suggestions[0].startsWith(prefix))
      check(t, suggestions[0], 'literal')
    }
    check(t, t.complete('cat ~/n')[0], 'home')
    assert.deepEqual(t.complete('cat ~'), ['cat ~/'])
    assert.deepEqual(t.complete('cat ~user/n'), [])
  })

  it('reads configured homes literally even when their names are shell syntax', () => {
    const home = '/work [x]/home *; "quote"'
    const t = createTerminal({ 'home *; "quote"/note [a]': 'home', 'home x/note a': 'wrong' }, { ...options, home })
    const suggestion = t.complete('cat ~/note')[0]
    assert.ok(suggestion.startsWith('cat ~/note'))
    check(t, suggestion, 'home')
    check(t, 'cd; pwd', home + '\n', home)
  })

  it('suppresses candidates requiring evaluation or an unfinished escape', () => {
    const t = fixture()
    for (const prefix of ['args $HOME/', 'args "dollar$n', 'args star*', 'args glob[n', 'args brace{n', 'args back\\', 'args -', 'args # comment', 'args `pwd`/', 'args $(pwd)/']) {
      assert.deepEqual(t.complete(prefix), [], prefix)
    }
    assert.deepEqual(t.complete('args # comment\ngre'), ['args # comment\ngrep'])
  })
})

describe('assignment recognition retains empty quotes before the equals sign', () => {
  for (const operand of ["''LONG=value", '""LONG=value', "L''ONG=value", 'LO""NG=value', "LONG''=value", 'LONG""=value', "LONG'='value", String.raw`LONG\=value`, '"LONG"=value']) {
    it(`${operand} remains a command word`, () => {
      const t = createTerminal({}, options)
      check(t, 'LONG=original', '')
      const result = t.run(`${operand} echo unexpected`)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 127)
      assert.equal(result.cwd, options.cwd)
      assert.match(result.stderr, /^LONG=value: command not found\./u)
      assert.deepEqual(result.unsupported, [{ kind: 'command', command: 'LONG=value', detail: 'LONG=value', message: result.stderr.trimEnd() }])
      check(t, 'printf "%s" "$LONG"', 'original')
    })
  }

  for (const [operand, expected] of [["LONG=''", ''], ['LONG=""', ''], ["LONG=''value", 'value'], ['LONG=""value', 'value'], ["LONG=value''", 'value'], ["LONG=val''ue", 'value']]) {
    it(`${operand} keeps empty quotes in the value valid`, () => {
      const t = createTerminal({}, options)
      check(t, `${operand}; printf '<%s>' "$LONG"`, '<' + expected + '>')
    })
  }

  it('recognizes an empty value before a special builtin', () => {
    const t = createTerminal({}, options)
    check(t, "LONG=before; LONG='' export LONG; printf '<%s>' \"$LONG\"", '<>')
  })

  it('retains ordinary splitting for export operands with a quoted assignment prefix', () => {
    const t = createTerminal({}, options)
    check(t, "V='one two'; export ''LONG=$V; printf '<%s>' \"$LONG\"", '<one>')
    check(t, "V='one two'; export LONG=$V; printf '<%s>' \"$LONG\"", '<one two>')
  })
})
