import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  f: 'x\n\nword\nword!\n!word\nx\r\n', g: 'x\n', blank: '\n',
  controls: 'x\r\na\rb\n\r\n', escapes: 't\nn\nr\n\t\n\\b\n\\y\n',
  'dir/f': 'inside\n', 'only-hidden/.x': '', '-maxdepth': '', '-2': 'two\n',
  'a.json': '{}\n', 'b.json': '{}\n',
  case: 'ä\nÄ\nß\nSS\nſ\ns\n', bytes: 'éx\néy\n',
  points: '\uE000\n😀\n', 'names/\uE000': '', 'names/😀': '',
}

function check(command, stdout, exitCode = 0, files = FILES) {
  const r = createTerminal(files).run(command)
  assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, '', exitCode, []], command)
}

describe('agent workflows — search results must preserve records', () => {
  for (const mode of ['', '-E', '-v .', '-A0', '-C1']) {
    it(`grep ${mode} retains a selected blank line through a pipeline`, () => {
      const pattern = mode === '-v .' ? '' : "'^$'"
      check(`grep ${mode} ${pattern} blank`, '\n')
      check(`grep ${mode} ${pattern} blank | wc -l`, '1\n')
    })
  }
  for (const mode of ['', '-E', '-o', '-Eo']) {
    it(`grep ${mode} dot includes carriage returns`, () => {
      check(`grep ${mode} '^.$' controls`, '\r\n')
      check(`grep ${mode} '^x.*$' controls`, 'x\r\n')
    })
    it(`grep ${mode} word assertions have direction`, () => {
      check(`grep ${mode} '\\>word\\<' f`, '', 1)
      check(`grep ${mode} '\\<word\\>' f`, mode.includes('o') ? 'word\nword\nword\n' : 'word\nword!\n!word\n')
    })
  }
  it('GNU ERE escapes do not become JS control escapes', () => {
    for (const c of ['t', 'n', 'r']) check(`grep -E '\\${c}' escapes`, c + '\n')
    for (const mode of ['-o', '-Eo']) check(`grep ${mode} '\\\\b' escapes`, '\\b\n')
  })
  it('context groups from separate files stay separated', () => {
    check('grep -n -A0 x f g', 'f:1:x\n--\nf:6:x\r\n--\ng:1:x\n')
    check('grep -h -C1 x f g', 'x\n\n--\n!word\nx\r\n--\nx\n')
  })
  it('recursive filename prefixes depend on how each file was reached', () => {
    check('grep -r x g', 'x\n')
    check('grep -rc x g', '1\n')
    check('grep -r inside dir', 'dir/f:inside\n')
    check('grep -rc inside dir', 'dir/f:1\n')
    check('grep -rh inside dir', 'inside\n')
    check('grep -r x g f', 'g:x\nf:x\nf:x\r\n')
    check('echo x | grep -r x -', 'x\n')
    check('echo x | grep -rH x -', '(standard input):x\n')
  })
})

describe('agent workflows — filesystem and find operands', () => {
  for (const path of ['f/', 'f/./', 'f/../g', 'missing/../g', 'dir/f/../f', '']) {
    for (const command of ['cat', 'head -n1', 'grep x', 'ls -d', 'find', "awk '{print}'"]) {
      it(`${command} refuses invalid traversal ${JSON.stringify(path)}`, () => {
        const r = createTerminal(FILES).run(`${command} '${path}'`)
        // AWK deliberately ignores an empty file operand, as gawk does.
        if (path === '' && command.startsWith('awk')) {
          assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], ['', '', 0, []])
          return
        }
        assert.equal(r.stdout, '')
        assert.notEqual(r.exitCode, 0)
        assert.match(r.stderr, /not a directory|no such file|is a directory/iu)
        assert.deepEqual(r.unsupported, [])
      })
    }
  }
  it('partial read failures retain valid file operands', () => {
    const r = createTerminal(FILES).run('cat g f/ g')
    assert.deepEqual([r.stdout, r.exitCode, r.unsupported], ['x\nx\n', 1, []])
    assert.match(r.stderr, /not a directory/iu)
    check('cat dir/../g', 'x\n')
    check('cat dir/./f', 'inside\n')
  })
  it('redirections and glob traversal obey directory components', () => {
    const r = createTerminal(FILES).run('cat < f/../g')
    assert.equal(r.stdout, '')
    assert.notEqual(r.exitCode, 0)
    check('echo f/../*.json', 'f/../*.json\n')
    check('echo missing/../*.json', 'missing/../*.json\n')
    check('echo dir/../*.json', 'dir/../a.json dir/../b.json\n')
    check('ls only-hidden', '')
  })
  it('pipe aliases share consumption and file aliases reopen the original input', () => {
    check('echo hi | { cat </dev/stdin; cat; }', 'hi\n')
    check('echo hi | { cat; cat </dev/stdin; }', 'hi\n')
    // The terminal models GNU/Linux file reopening, as opposed to BSD's
    // dup-style /dev/fd. Reopening must keep the original contents after
    // another command has consumed a prefix of the shared descriptor.
    const files = { f: 'first\nsecond\n' }
    for (const alias of ['cat /dev/stdin', 'cat </dev/stdin']) {
      check(`{ head -n1; ${alias}; cat; } < f`, 'first\nfirst\nsecond\nsecond\n', 0, files)
    }
    check(`awk '{print} END {print NR}' /dev/null`, '0\n')
    check(`awk '{print}' /dev/stdin /dev/stdin < f`, files.f + files.f, 0, files)
  })
  it('AWK program files and getline cannot bypass path traversal checks', () => {
    const r = createTerminal(FILES).run('awk -f missing/../f')
    assert.notEqual(r.exitCode, 0)
    check(`awk 'BEGIN { print (getline x < "f/../g"), ERRNO }'`, '-1 Not a directory\n')
  })
  it('find leaves option-looking patterns and child arguments intact', () => {
    check('find . -name -maxdepth', './-maxdepth\n')
    check("find . -maxdepth 0 -exec echo -maxdepth 2 '{}' ';'", '-maxdepth 2 .\n')
    check("find . -maxdepth 0 -exec echo + '{}' ';'", '+ .\n')
    check("find . -maxdepth 0 -exec echo '{}' +", '.\n')
    check('find . -maxdepth 0 -exec echo {} \\;', '.\n')
    check("find . -maxdepth 0 -not -maxdepth 1", '')
  })
  it('find keeps lexical root names and recognizes the empty root', () => {
    check('find dir/.. -maxdepth 0 -name ..', 'dir/..\n')
    check('find dir/. -maxdepth 0 -name .', 'dir/.\n')
    check('find . -empty', '.\n', 0, {})
  })
  it('custom handlers see the same validated filesystem', () => {
    const t = createTerminal(FILES, { commands: { inspect: {
      run: ({ fs }) => JSON.stringify([fs.isFile('f/../g'), fs.readFile('missing/../g'), fs.walkFiles('f/../dir')]),
    } } })
    assert.equal(t.run('inspect').stdout, '[false,null,[]]')
  })
  it('reentrant run calls do not inherit the outer input descriptor', () => {
    const t = createTerminal(FILES, { commands: { nested: {
      run: ({ readInputs }) => {
        assert.equal(t.run('cat /dev/stdin').stdout, '')
        return readInputs(['/dev/stdin']).inputs[0].content
      },
    } } })
    assert.equal(t.run('{ head -c1; nested; cat; } < g').stdout, 'xx\n')
  })
})

describe('agent workflows — deduplication and ordering', () => {
  it('case folding does not merge unrelated Unicode records', () => {
    check('sort -fu case', 's\nSS\nÄ\nß\nä\nſ\n')
    check('uniq -i case', FILES.case)
  })
  it('uniq slices byte comparison keys without decoding partial UTF-8', () => {
    check('uniq -s2 bytes', 'éx\néy\n')
    check('uniq -w2 bytes', 'éx\n')
    check('uniq -w1 case', 'ä\nSS\nſ\ns\n')
  })
  it('sort, ls, and shell globs use UTF-8 lexical ordering', () => {
    check('sort points', '\uE000\n😀\n')
    check('sort -r points', '😀\n\uE000\n')
    check('ls names', '\uE000\n😀\n')
    check('echo names/*', 'names/\uE000 names/😀\n')
  })
})

describe('agent workflows — silent option and metadata gaps', () => {
  for (const command of ['grep -2 x g', 'cat -2 g', 'head -n1 -2 g', 'tail -n1 -2 g',
    "echo 'é' | grep '^.$'", "echo 'k' | grep -Fi 'K'", "echo -e 'a\\0b' | grep a",
    `awk 'BEGIN { PROCINFO["sorted_in"]="@ind_num_asc"; a[2]=2; a[1]=1; for (k in a) print k }'`,
    `awk 'BEGIN { print PROCINFO["pid"] }'`, `awk 'BEGIN { print length(PROCINFO) }'`,
    `awk 'BEGIN { for (k in PROCINFO) print k }'`, `awk 'BEGIN { print ENVIRON["HOME"] }'`,
    `awk 'BEGIN { print length(ENVIRON) }'`]) {
    it(`${command} reports a diagnostic instead of fabricated results`, () => {
      const r = createTerminal(FILES).run(command)
      assert.equal(r.stdout, '')
      assert.notEqual(r.exitCode, 0)
      assert.notEqual(r.stderr, '')
      assert.equal(r.unsupported.length, 1)
      const hidden = createTerminal(FILES).run(`${command} 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '')
      assert.deepEqual(hidden.unsupported, r.unsupported)
    })
  }
  it('-- protects numeric filenames and supported count forms still work', () => {
    check('cat -- -2', 'two\n')
    check('head -2 f', 'x\n\n')
    check('head -2 -n1 f', 'x\n')
    check('tail -2 g', 'x\n')
    check('seq -2 0', '-2\n-1\n0\n')
  })
  it('literal Unicode search remains supported without locale-sensitive rules', () => {
    check("echo 'é' | grep -F 'é'", 'é\n')
    check("echo 'é' | grep '^é$'", 'é\n')
  })
  it('virtual bin aliases do not invent executables for shell-only builtins', () => {
    const r = createTerminal(FILES).run('x="a b"; /usr/bin/export y=$x')
    assert.equal(r.exitCode, 127)
    assert.equal(r.unsupported[0].command, '/usr/bin/export')
  })
})
