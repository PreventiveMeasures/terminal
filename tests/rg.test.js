import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

// Checked against ripgrep 14.1.0. Its default walk is parallel and unordered,
// so comparisons use `rg --sort path`, the order it documents as stable.
const FILES = {
  'a.txt': 'oak tree\nelm\nOAK\n', 'sub/b.js': 'const oak = 1\noak oak\n',
  'sub/deep/c.md': '# oak\n', 'README.md': 'no match here\n',
  '.hidden': 'oak hidden\n', '.dot/e.txt': 'oak dotdir\n', 'sub/.h/f.txt': 'oak deep hidden\n',
}
const run = (command, files = FILES) => createTerminal(files).run(command)
const hiddenNote = (count, paths) =>
  `rg: skipped ${count} hidden ${count === 1 ? 'entry' : 'entries'}: ${paths.map((p) => JSON.stringify(p)).join(', ')}. Hidden entries are searched with --hidden.`

describe('rg searches the tree the way ripgrep does', () => {
  for (const [command, stdout] of [
    ['rg oak', 'a.txt:oak tree\nsub/b.js:const oak = 1\nsub/b.js:oak oak\nsub/deep/c.md:# oak\n'],
    // Line numbers are off unless asked for, unlike grep's own habit of -n.
    ['rg -n oak', 'a.txt:1:oak tree\nsub/b.js:1:const oak = 1\nsub/b.js:2:oak oak\nsub/deep/c.md:1:# oak\n'],
    ['rg oak sub', 'sub/b.js:const oak = 1\nsub/b.js:oak oak\nsub/deep/c.md:# oak\n'],
    // A single named file prints no path prefix; a named directory does.
    ['rg oak a.txt', 'oak tree\n'],
    ['rg -i oak a.txt', 'oak tree\nOAK\n'],
    ['rg -l oak', 'a.txt\nsub/b.js\nsub/deep/c.md\n'],
    ['rg -w oak a.txt', 'oak tree\n'],
    ['rg -F "oak tree" a.txt', 'oak tree\n'],
    ['rg -v oak a.txt', 'elm\nOAK\n'],
    // An explicit `.` is echoed back in the paths, as ripgrep echoes its operand.
    ['rg oak .', './a.txt:oak tree\n./sub/b.js:const oak = 1\n./sub/b.js:oak oak\n./sub/deep/c.md:# oak\n'],
  ]) {
    it(command, () => assert.equal(run(command).stdout, stdout))
  }

  it('counts only the files that matched', () => {
    // grep -c reports a 0 for every file it opened; ripgrep omits those rows.
    assert.equal(run('rg -c oak').stdout, 'a.txt:1\nsub/b.js:2\nsub/deep/c.md:1\n')
    assert.equal(run('rg -c oak README.md').stdout, '')
    assert.equal(run('rg -c oak README.md').exitCode, 1)
  })

  it('reads standard input instead of the tree when a pipe supplies one', () => {
    assert.equal(run("printf 'oak\\nelm\\n' | rg oak").stdout, 'oak\n')
    assert.equal(run("printf 'oak\\nelm\\noak2\\n' | rg -n oak").stdout, '1:oak\n3:oak2\n')
    assert.equal(run('rg oak < a.txt').stdout, 'oak tree\n')
  })

  it('exits 1 on no match and 2 on a bad path', () => {
    assert.equal(run('rg zzz').exitCode, 1)
    assert.equal(run('rg oak nosuchpath').exitCode, 2)
  })
})

describe('rg leaves hidden entries out of a walk and says so', () => {
  it('skips them and reports what it skipped', () => {
    const result = run('rg oak')
    assert.deepEqual(result.notes, [hiddenNote(3, ['/.dot', '/.hidden', '/sub/.h'])])
  })

  it('searches them with --hidden', () => {
    const result = run('rg --hidden oak')
    assert.equal(result.stdout,
      '.dot/e.txt:oak dotdir\n.hidden:oak hidden\na.txt:oak tree\nsub/.h/f.txt:oak deep hidden\nsub/b.js:const oak = 1\nsub/b.js:oak oak\nsub/deep/c.md:# oak\n')
    assert.deepEqual(result.notes, [])
  })

  it('searches a hidden file named outright', () => {
    assert.equal(run('rg oak .hidden').stdout, 'oak hidden\n')
  })

  it('refuses a hidden path named beside a directory', () => {
    // One run cannot both search a named hidden path and skip hidden entries
    // while walking, so neither answer is given.
    const result = run('rg oak .hidden sub')
    assert.equal(result.stdout, '')
    assert.equal(result.unsupported.length, 1)
    assert.equal(result.unsupported[0].detail, 'named hidden path')
  })
})

describe('rg refuses the filtering it does not implement', () => {
  const B = { 'a.txt': 'oak\n', 'sub/b.js': 'oak\n' }
  for (const [label, files] of [
    ['.gitignore inside a git repository', { ...B, '.gitignore': '*.js\n', '.git/HEAD': 'ref\n' }],
    ['.ignore', { ...B, '.ignore': '*.js\n' }],
    ['.rgignore', { ...B, '.rgignore': '*.js\n' }],
  ]) {
    it(label, () => {
      const result = run('rg oak', files)
      assert.equal(result.stdout, '')
      assert.equal(result.unsupported[0].detail, 'ignore rules')
    })
  }

  it('searches normally when a .gitignore has no repository to apply to', () => {
    // ripgrep only honors .gitignore inside a git repository.
    const result = run('rg oak', { ...B, '.gitignore': '*.js\n' })
    assert.equal(result.stdout, 'a.txt:oak\nsub/b.js:oak\n')
    assert.deepEqual(result.unsupported, [])
  })

  it('searches everything with --no-ignore, whichever ignore file is present', () => {
    for (const name of ['.ignore', '.rgignore', '.gitignore']) {
      const result = run('rg --no-ignore oak', { ...B, [name]: '*.js\n' })
      assert.equal(result.stdout, 'a.txt:oak\nsub/b.js:oak\n', name)
      assert.deepEqual(result.unsupported, [], name)
    }
  })
})

describe('rg refuses what its own regex engine refuses', () => {
  // Rust's regex crate has no backtracking. PCRE would answer these, so passing
  // them through would report matches where ripgrep reports a parse error.
  for (const [pattern, detail] of [
    ['(a)\\1', 'backreference'], ['foo(?=b)', 'look-around'], ['foo(?!b)', 'look-around'],
    ['(?<=a)b', 'look-around'], ['\\Qa.b\\E', '\\Q…\\E literal span'],
  ]) {
    it(pattern, () => {
      const result = run(`rg ${JSON.stringify(pattern)}`)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 2)
      assert.equal(result.unsupported[0].detail, detail)
    })
  }

  it('takes them literally under -F, where no engine parses them', () => {
    assert.equal(run('rg -F "(a)\\1" a.txt').exitCode, 1)
    assert.deepEqual(run('rg -F "(a)\\1" a.txt').unsupported, [])
  })
})

describe('rg refuses the options it does not implement', () => {
  for (const flag of ['-t js', '-g *.js', '--files', '--json', '-o', '--column', '--stats',
    '-U', '--pcre2', '-z', '--heading', '--max-depth 1', '-r X', '--sort path', '--vimgrep']) {
    it(flag, () => {
      const result = run(`rg ${flag} oak`)
      assert.equal(result.stdout, '')
      assert.equal(result.exitCode, 2)
      assert.equal(result.unsupported.length, 1)
      assert.equal(result.unsupported[0].command, 'rg')
    })
  }

  it('stays diagnosed when stderr is hidden', () => {
    const result = run('rg --files oak 2>/dev/null | cat')
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
    assert.equal(result.unsupported.length, 1)
  })
})

describe('rg reads repeated and cancelling options the way ripgrep does', () => {
  const B = { 'a.txt': 'oak\nOAK\n', 'sub/b.js': 'oak\n', '.hidden': 'oak hidden\n' }
  // Last one wins for every pair that cancels.
  for (const [command, stdout] of [
    ['rg -i -s oak', 'a.txt:oak\nsub/b.js:oak\n'],
    ['rg -s -i oak', 'a.txt:oak\na.txt:OAK\nsub/b.js:oak\n'],
    ['rg -n -N oak', 'a.txt:oak\nsub/b.js:oak\n'],
    ['rg -N -n oak', 'a.txt:1:oak\nsub/b.js:1:oak\n'],
    ['rg -c -l oak', 'a.txt\nsub/b.js\n'],
    ['rg -l -c oak', 'a.txt:1\nsub/b.js:1\n'],
    ['rg -i -s -i oak', 'a.txt:oak\na.txt:OAK\nsub/b.js:oak\n'],
  ]) {
    it(command, () => assert.equal(run(command, B).stdout, stdout))
  }

  // -u reduces filtering a step at a time, so it has to be counted.
  it('escalates with each -u', () => {
    assert.equal(run('rg -u oak', B).stdout, 'a.txt:oak\nsub/b.js:oak\n')
    for (const command of ['rg -uu oak', 'rg -u -u oak', 'rg --unrestricted --unrestricted oak']) {
      assert.equal(run(command, B).stdout, '.hidden:oak hidden\na.txt:oak\nsub/b.js:oak\n', command)
    }
    // A third -u asks for binary files to be reported, which needs ripgrep's
    // own binary output.
    assert.equal(run('rg -uuu oak', B).unsupported[0].detail, '-uuu')
  })

  it('matches the union of repeated patterns', () => {
    assert.equal(run('rg -e oak -e elm', { 'a.txt': 'oak\nelm\nash\n' }).stdout, 'a.txt:oak\na.txt:elm\n')
    assert.equal(run('rg -e "^oak" -e "elm$"', { 'a.txt': 'oak\nelm\nash\n' }).stdout, 'a.txt:oak\na.txt:elm\n')
    // -F keeps each pattern literal rather than joining them into a regex.
    assert.equal(run('rg -F -e oak -e elm', { 'a.txt': 'oak\nelm\nash\n' }).stdout, 'a.txt:oak\na.txt:elm\n')
  })

  it('spells the filename flags the way ripgrep does', () => {
    // -H is --with-filename and -I is --no-filename; -h is --help, not a search.
    assert.equal(run('rg -H oak a.txt', B).stdout, 'a.txt:oak\n')
    assert.equal(run('rg -I oak', B).stdout, 'oak\noak\n')
    assert.equal(run('rg -h oak', B).unsupported[0].detail, '-h')
  })
})

describe('rg skips binary files while walking and refuses a named one', () => {
  const B = { 't.txt': 'oak\n', 'b.dat': 'oak\u0000bin\n' }
  it('leaves a binary file out of a walk, as ripgrep does', () => {
    const result = run('rg oak .', B)
    assert.equal(result.stdout, './t.txt:oak\n')
    assert.equal(result.exitCode, 0)
    assert.deepEqual(result.unsupported, [])
  })

  it('refuses a binary file named outright', () => {
    // ripgrep answers "binary file matches" here, which this runtime cannot print.
    assert.equal(run('rg oak b.dat', B).unsupported[0].detail, 'named binary file')
  })

  it('searches it as text with -a', () => {
    assert.equal(run('rg -a oak b.dat', B).exitCode, 0)
  })
})

describe('rg decides between standard input and the tree the way ripgrep does', () => {
  const B = { 'a.txt': 'oak\n', 'sub/b.js': 'oak\n' }
  it('searches a pipe even when it carries nothing', () => {
    // An empty pipe is still connected input, so the tree is not searched.
    assert.equal(run("printf '' | rg oak", B).exitCode, 1)
    assert.equal(run("printf '' | rg oak", B).stdout, '')
    assert.equal(run('true | rg oak', B).exitCode, 1)
  })

  it('searches the tree with no pipe at all', () => {
    assert.equal(run('rg oak', B).stdout, 'a.txt:oak\nsub/b.js:oak\n')
  })

  it('treats a redirected file as input and /dev/null as none', () => {
    assert.equal(run('rg oak < a.txt', B).stdout, 'oak\n')
    // ripgrep reads a file or a pipe, not a character device.
    assert.equal(run('rg oak < /dev/null', B).stdout, 'a.txt:oak\nsub/b.js:oak\n')
  })

  it('still prefers a named path over the pipe', () => {
    assert.equal(run("printf 'elm\\n' | rg oak a.txt", B).stdout, 'oak\n')
  })
})

describe('rg resolves context flags before running', () => {
  const B = { 'a.txt': 'oak tree\nelm\nOAK\noak\n' }
  for (const [command, stdout] of [
    ['rg -C1 oak a.txt', 'oak tree\nelm\nOAK\noak\n'],
    // grep prints a `--` at zero context; ripgrep prints nothing.
    ['rg -A0 oak a.txt', 'oak tree\noak\n'],
    ['rg -B0 oak a.txt', 'oak tree\noak\n'],
    // -A and -B override -C whichever order they come in.
    ['rg -C1 -A0 oak a.txt', 'oak tree\n--\nOAK\noak\n'],
    ['rg -A0 -C1 oak a.txt', 'oak tree\n--\nOAK\noak\n'],
    ['rg -C1 -B0 oak a.txt', 'oak tree\nelm\n--\noak\n'],
    // Repeats of one flag are last-one-wins.
    ['rg -A2 -A1 oak a.txt', 'oak tree\nelm\n--\noak\n'],
  ]) {
    it(command, () => assert.equal(run(command, B).stdout, stdout))
  }
})

describe('rg refuses a pattern its engine rejects for line-based search', () => {
  const B = { 'a.txt': 'oak\n' }
  for (const pattern of ['oak\\n', '\\n', '[\\n]', '\\x0A']) {
    it(JSON.stringify(pattern), () => {
      // ripgrep errors here rather than never matching, so returning "no match"
      // would be an answer it never gives.
      const result = run(`rg -- ${JSON.stringify(pattern)} a.txt`, B)
      assert.equal(result.exitCode, 2)
      assert.equal(result.unsupported[0].detail, 'newline in a pattern')
    })
  }

  for (const pattern of ['\\r', '\\s', '\\t', 'oak']) {
    it(`${JSON.stringify(pattern)} is allowed`, () => {
      assert.deepEqual(run(`rg -- ${JSON.stringify(pattern)} a.txt`, B).unsupported, [])
    })
  }
})

describe('rg refuses a byte-order mark rather than matching through it', () => {
  // ripgrep strips a leading BOM before matching, so `^oak` matches there and
  // the mark never reaches the output; grep does neither.
  const B = { 'bom.txt': '\uFEFFoak\n', 'plain.txt': 'oak\n' }
  it('named outright', () => {
    assert.equal(run('rg oak bom.txt', B).unsupported[0].detail, 'byte-order mark')
  })
  it('found while walking', () => {
    assert.equal(run('rg oak', B).unsupported[0].detail, 'byte-order mark')
  })
  it('leaves an unmarked tree alone', () => {
    assert.deepEqual(run('rg oak', { 'plain.txt': 'oak\n' }).unsupported, [])
  })
})

describe('rg walks from a starting point that is itself dot-named', () => {
  const B = { 'a.txt': 'oak\n', 'sub/b.js': 'oak\n', '.hidden': 'oak hidden\n', 'sub/.h/g.txt': 'oak nested\n' }
  it('searches the parent from a subdirectory', () => {
    // `..` and `.` are dot-named, so a glob that removes hidden directories has
    // to spare them or the walk starts nowhere.
    const t = createTerminal(B, { cwd: '/sub' })
    assert.equal(t.run('rg oak ..').stdout, '../a.txt:oak\n../sub/b.js:oak\n')
    assert.equal(t.run('rg oak .').stdout, './b.js:oak\n')
  })

  it('still leaves hidden directories out of that walk', () => {
    const t = createTerminal(B, { cwd: '/sub' })
    assert.equal(t.run('rg --hidden oak ..').stdout,
      '../.hidden:oak hidden\n../a.txt:oak\n../sub/.h/g.txt:oak nested\n../sub/b.js:oak\n')
  })

  it('keeps a directory whose name only begins with two dots out of a walk', () => {
    const files = { 'a.txt': 'oak\n', '..odd/g.txt': 'oak odd\n' }
    assert.equal(run('rg oak', files).stdout, 'a.txt:oak\n')
    assert.equal(run('rg --hidden oak', files).stdout, '..odd/g.txt:oak odd\na.txt:oak\n')
  })
})

describe('rg only refuses a named hidden path when it is also filtering', () => {
  const B = { 'a.txt': 'oak\n', 'sub/b.js': 'oak\n', '.hidden': 'oak hidden\n' }
  it('refuses while hidden entries are being skipped', () => {
    assert.equal(run('rg oak .hidden sub', B).unsupported[0].detail, 'named hidden path')
  })

  it('accepts it with --hidden, where nothing is filtered', () => {
    const result = run('rg --hidden oak .hidden sub', B)
    assert.equal(result.stdout, '.hidden:oak hidden\nsub/b.js:oak\n')
    assert.deepEqual(result.unsupported, [])
  })

  it('accepts it with -uu, which implies --hidden', () => {
    assert.deepEqual(run('rg -uu oak .hidden sub', B).unsupported, [])
  })
})

describe('rg says so when a filter left it nothing to open', () => {
  it('reports it when it chose the starting point itself', () => {
    // Everything here is hidden, so the walk opens no file at all. ripgrep
    // treats that as a mistake rather than a miss.
    const result = run('rg oak', { '.hid/a.txt': 'oak\n' })
    assert.equal(result.exitCode, 2)
    assert.equal(result.stderr,
      "rg: No files were searched, which means ripgrep probably applied a filter you didn't expect.\n" +
      'Running with --debug will show why files are being skipped.\n')
  })

  for (const mode of ['-q', '-l', '-c', '-n']) {
    it(`reports it under ${mode} too`, () => {
      assert.equal(run(`rg ${mode} oak`, { '.hid/a.txt': 'oak\n' }).exitCode, 2)
    })
  }

  it('is a plain miss once a starting point is named, even `.`', () => {
    for (const command of ['rg oak .', 'rg oak sub', 'rg oak ./sub']) {
      const result = run(command, { 'sub/.hid/a.txt': 'oak\n' })
      assert.equal(result.exitCode, 1, command)
      assert.equal(result.stderr, '', command)
    }
  })

  it('says nothing when a file was opened and simply did not match', () => {
    const result = run('rg oak', { 'v.txt': 'elm\n' })
    assert.equal(result.exitCode, 1)
    assert.equal(result.stderr, '')
  })

  it('opens the hidden files with --hidden and finds them', () => {
    assert.equal(run('rg --hidden oak', { '.hid/a.txt': 'oak\n' }).stdout, '.hid/a.txt:oak\n')
  })
})

describe('rg refuses rather than quietly accepting a bad option value', () => {
  const B = { 'a.txt': 'oak\nelm\n' }
  for (const [command, flag] of [
    ['rg -A abc oak a.txt', '-A'], ['rg -A -1 oak a.txt', '-A'], ['rg -A 1.5 oak a.txt', '-A'],
    ['rg -B x oak a.txt', '-B'], ['rg --context=x oak a.txt', '--context'],
  ]) {
    it(command, () => {
      // Ignoring the value would search with no context and look like success.
      const result = run(command, B)
      assert.equal(result.exitCode, 2)
      assert.equal(result.stderr, `rg: error parsing flag ${flag}: value is not a valid number\n`)
      assert.equal(result.unsupported.length, 1)
    })
  }
})

describe('every rg refusal reaches the diagnostic feed', () => {
  const B = { 'a.txt': 'oak\n' }
  // A refusal that only reached stderr would vanish under `2>/dev/null`.
  for (const command of ['rg "[" a.txt', 'rg "(" a.txt', 'rg "a{2,1}" a.txt', String.raw`rg '\' a.txt`,
    'rg -e', 'rg -A', 'rg -A abc oak a.txt', 'rg -t js oak', 'rg --sort path oak', 'rg']) {
    it(command, () => {
      const result = run(command, B)
      assert.equal(result.exitCode, 2, command)
      assert.equal(result.unsupported.length, 1, command)
      assert.equal(result.unsupported[0].command, 'rg')
      const hidden = run(`${command} 2>/dev/null`, B)
      assert.equal(hidden.stderr, '')
      assert.equal(hidden.unsupported.length, 1)
    })
  }

  it('names the pattern rather than the engine underneath', () => {
    // grep words this in terms of its own PCRE subset, which ripgrep never uses.
    const result = run('rg "[" a.txt', B)
    assert.match(result.stderr, /^rg: regex parse error in "\["/u)
    assert.doesNotMatch(result.stderr, /PCRE/u)
  })
})
