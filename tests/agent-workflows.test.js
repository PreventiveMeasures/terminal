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

async function check(command, stdout, exitCode = 0, files = FILES) {
  const r = await createTerminal(files).run(command)
  assert.deepEqual([r.stdout, r.stderr, r.exitCode, r.unsupported], [stdout, '', exitCode, []], command)
}

describe('agent workflows — search results must preserve records', () => {
  for (const mode of ['', '-E', '-v .', '-A0', '-C1']) {
    it(`grep ${mode} retains a selected blank line through a pipeline`, async () => {
      const pattern = mode === '-v .' ? '' : "'^$'"
      await check(`grep ${mode} ${pattern} blank`, '\n')
      await check(`grep ${mode} ${pattern} blank | wc -l`, '1\n')
    })
  }
  for (const mode of ['', '-E', '-o', '-Eo']) {
    it(`grep ${mode} dot includes carriage returns`, async () => {
      await check(`grep ${mode} '^.$' controls`, '\r\n')
      await check(`grep ${mode} '^x.*$' controls`, 'x\r\n')
    })
    it(`grep ${mode} word assertions have direction`, async () => {
      await check(`grep ${mode} '\\>word\\<' f`, '', 1)
      await check(`grep ${mode} '\\<word\\>' f`, mode.includes('o') ? 'word\nword\nword\n' : 'word\nword!\n!word\n')
    })
  }
  it('GNU ERE escapes do not become JS control escapes', async () => {
    for (const c of ['t', 'n', 'r']) await check(`grep -E '\\${c}' escapes`, c + '\n')
    for (const mode of ['-o', '-Eo']) await check(`grep ${mode} '\\\\b' escapes`, '\\b\n')
  })
  it('context groups from separate files stay separated', async () => {
    await check('grep -n -A0 x f g', 'f:1:x\n--\nf:6:x\r\n--\ng:1:x\n')
    await check('grep -h -C1 x f g', 'x\n\n--\n!word\nx\r\n--\nx\n')
  })
  it('recursive filename prefixes depend on how each file was reached', async () => {
    await check('grep -r x g', 'x\n')
    await check('grep -rc x g', '1\n')
    await check('grep -r inside dir', 'dir/f:inside\n')
    await check('grep -rc inside dir', 'dir/f:1\n')
    await check('grep -rh inside dir', 'inside\n')
    await check('grep -r x g f', 'g:x\nf:x\nf:x\r\n')
    await check('echo x | grep -r x -', 'x\n')
    await check('echo x | grep -rH x -', '(standard input):x\n')
  })
})

describe('agent workflows — filesystem and find operands', () => {
  for (const path of ['f/', 'f/./', 'f/../g', 'missing/../g', 'dir/f/../f', '']) {
    for (const command of ['cat', 'head -n1', 'grep x', 'ls -d', 'find', "awk '{print}'"]) {
      it(`${command} refuses invalid traversal ${JSON.stringify(path)}`, async () => {
        const r = await createTerminal(FILES).run(`${command} '${path}'`)
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
  it('partial read failures retain valid file operands', async () => {
    const r = await createTerminal(FILES).run('cat g f/ g')
    assert.deepEqual([r.stdout, r.exitCode, r.unsupported], ['x\nx\n', 1, []])
    assert.match(r.stderr, /not a directory/iu)
    await check('cat dir/../g', 'x\n')
    await check('cat dir/./f', 'inside\n')
  })
  it('redirections and glob traversal obey directory components', async () => {
    const r = await createTerminal(FILES).run('cat < f/../g')
    assert.equal(r.stdout, '')
    assert.notEqual(r.exitCode, 0)
    await check('echo f/../*.json', 'f/../*.json\n')
    await check('echo missing/../*.json', 'missing/../*.json\n')
    await check('echo dir/../*.json', 'dir/../a.json dir/../b.json\n')
    await check('ls only-hidden', '')
  })
  it('pipe aliases share consumption and file aliases reopen the original input', async () => {
    await check('echo hi | { cat </dev/stdin; cat; }', 'hi\n')
    await check('echo hi | { cat; cat </dev/stdin; }', 'hi\n')
    // The terminal models GNU/Linux file reopening, as opposed to BSD's
    // dup-style /dev/fd. Reopening must keep the original contents after
    // another command has consumed a prefix of the shared descriptor.
    const files = { f: 'first\nsecond\n' }
    for (const alias of ['cat /dev/stdin', 'cat </dev/stdin']) {
      await check(`{ head -n1; ${alias}; cat; } < f`, 'first\nfirst\nsecond\nsecond\n', 0, files)
    }
    await check(`awk '{print} END {print NR}' /dev/null`, '0\n')
    await check(`awk '{print}' /dev/stdin /dev/stdin < f`, files.f + files.f, 0, files)
  })
  it('AWK program files and getline cannot bypass path traversal checks', async () => {
    const r = await createTerminal(FILES).run('awk -f missing/../f')
    assert.notEqual(r.exitCode, 0)
    await check(`awk 'BEGIN { print (getline x < "f/../g"), ERRNO }'`, '-1 Not a directory\n')
  })
  it('find leaves option-looking patterns and child arguments intact', async () => {
    await check('find . -name -maxdepth', './-maxdepth\n')
    await check("find . -maxdepth 0 -exec echo -maxdepth 2 '{}' ';'", '-maxdepth 2 .\n')
    await check("find . -maxdepth 0 -exec echo + '{}' ';'", '+ .\n')
    await check("find . -maxdepth 0 -exec echo '{}' +", '.\n')
    await check('find . -maxdepth 0 -exec echo {} \\;', '.\n')
    await check("find . -maxdepth 0 -not -maxdepth 1", '')
  })
  it('find keeps lexical root names and recognizes the empty root', async () => {
    await check('find dir/.. -maxdepth 0 -name ..', 'dir/..\n')
    await check('find dir/. -maxdepth 0 -name .', 'dir/.\n')
    await check('find . -empty', '.\n', 0, {})
  })
  it('custom handlers see the same validated filesystem', async () => {
    const t = createTerminal(FILES, { commands: { inspect: {
      run: ({ fs }) => JSON.stringify([fs.isFile('f/../g'), fs.readFile('missing/../g'), fs.walkFiles('f/../dir')]),
    } } })
    assert.equal((await t.run('inspect')).stdout, '[false,null,[]]')
  })
  it('reentrant run calls do not inherit the outer input descriptor', async () => {
    const t = createTerminal(FILES, { commands: { nested: {
      run: async ({ readInputs, run }) => {
        assert.equal((await run('cat /dev/stdin')).stdout, '')
        return readInputs(['/dev/stdin']).inputs[0].content
      },
    } } })
    assert.equal((await t.run('{ head -c1; nested; cat; } < g')).stdout, 'xx\n')
  })
})

describe('agent workflows — deduplication and ordering', () => {
  it('case folding does not merge unrelated Unicode records', async () => {
    await check('sort -fu case', 's\nSS\nÄ\nß\nä\nſ\n')
    await check('uniq -i case', FILES.case)
  })
  it('uniq slices byte comparison keys without decoding partial UTF-8', async () => {
    await check('uniq -s2 bytes', 'éx\néy\n')
    await check('uniq -w2 bytes', 'éx\n')
    await check('uniq -w1 case', 'ä\nSS\nſ\ns\n')
  })
  it('sort, ls, and shell globs use UTF-8 lexical ordering', async () => {
    await check('sort points', '\uE000\n😀\n')
    await check('sort -r points', '😀\n\uE000\n')
    await check('ls names', '\uE000\n😀\n')
    await check('echo names/*', 'names/\uE000 names/😀\n')
  })
  it('whole-line sort keys preserve Unicode ordering and deduplication with either record separator', async () => {
    for (const delimiter of ['\n', '\0']) {
      const files = { records: ['😀', 'é', '\uE000', 'a', '😀', 'a'].join(delimiter) + delimiter }
      const ascending = ['a', 'é', '\uE000', '😀']
      for (const key of ['', '-k1']) {
        const mode = delimiter === '\0' ? '-zu' : '-u'
        await check(`sort ${mode} ${key} records`, ascending.join(delimiter) + delimiter, 0, files)
        await check(`sort ${mode} -r ${key} records`, ascending.toReversed().join(delimiter) + delimiter, 0, files)
      }
    }
  })
})

describe('agent workflows — silent option and metadata gaps', () => {
  for (const command of ['grep -2 x g', 'cat -2 g', 'head -n1 -2 g', 'tail -n1 -2 g', "echo -e 'a\\0b' | grep a",
    `awk 'BEGIN { PROCINFO["sorted_in"]="@ind_num_asc"; a[2]=2; a[1]=1; for (k in a) print k }'`,
    `awk 'BEGIN { print PROCINFO["pid"] }'`, `awk 'BEGIN { print length(PROCINFO) }'`,
    `awk 'BEGIN { for (k in PROCINFO) print k }'`, `awk 'BEGIN { print ENVIRON["HOME"] }'`,
    `awk 'BEGIN { print length(ENVIRON) }'`]) {
    it(`${command} reports a diagnostic instead of fabricated results`, async () => {
      const r = await createTerminal(FILES).run(command)
      assert.equal(r.stdout, '')
      assert.notEqual(r.exitCode, 0)
      assert.notEqual(r.stderr, '')
      assert.equal(r.unsupported.length, 1)
      const hidden = await createTerminal(FILES).run(`${command} 2>/dev/null | cat`)
      assert.equal(hidden.stderr, '')
      assert.deepEqual(hidden.unsupported, r.unsupported)
    })
  }
  it('-- protects numeric filenames and supported count forms still work', async () => {
    await check('cat -- -2', 'two\n')
    await check('head -2 f', 'x\n\n')
    await check('head -2 -n1 f', 'x\n')
    await check('tail -2 g', 'x\n')
    await check('seq -2 0', '-2\n-1\n0\n')
  })
  it('Unicode search reads the C.UTF-8 tables', async () => {
    await check("echo 'é' | grep -F 'é'", 'é\n')
    await check("echo 'é' | grep '^é$'", 'é\n')
    await check("echo 'é' | grep '^[[:alpha:]]$'", 'é\n')
    // The Kelvin sign is its own upper case, so `k` does not fold to it.
    check("echo 'k' | grep -Fi 'K'", '', 1)
  })
  it('virtual bin aliases do not invent executables for shell-only builtins', async () => {
    const r = await createTerminal(FILES).run('x="a b"; /usr/bin/export y=$x')
    assert.equal(r.exitCode, 127)
    assert.equal(r.unsupported[0].command, '/usr/bin/export')
  })
})
