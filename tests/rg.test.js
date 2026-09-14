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
