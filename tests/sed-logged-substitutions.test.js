import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const CASES = [
  {
    purpose: 'double quotes retain escaped BRE captures and an escaped slash',
    command: String.raw`sed "s/.*a '\(@a\/[^']*\)'.*/\1/"`,
    input: "import a '@a/core';\na '@a/one'; a '@a/two';\na '@b/other';\na \"@a/double\";\n",
    stdout: '@a/core\n@a/two\na \'@b/other\';\na "@a/double";\n',
  },
  {
    purpose: 'a double-quoted greedy prefix substitution chooses the last occurrence',
    command: 'sed "s/.*a //"',
    input: 'prefix a one a two\na value\nunchanged\n',
    stdout: 'two\nvalue\nunchanged\n',
  },
  {
    purpose: 'hash delimiters remove the requested directory and its suffix',
    command: "sed 's#/a/.*##'",
    input: 'root/a/file.ts\n/a/deep/file.ts\nroot/ab/file.ts\n',
    stdout: 'root\n\nroot/ab/file.ts\n',
  },
  {
    purpose: 'an unanchored directory substitution replaces only the first occurrence',
    command: "sed 's#a/##'",
    input: 'a/file.ts\na/a/file.ts\nroot/ba/file.ts\nroot/b/file.ts\n',
    stdout: 'file.ts\na/file.ts\nroot/bfile.ts\nroot/b/file.ts\n',
  },
  {
    purpose: 'a capture before a literal parenthesis leaves the unmatched suffix intact',
    command: String.raw`sed 's/.*:\(a\.[A-Za-z]*\)(/\1/'`,
    input: 'file.ts:12:a.Method(argument)\nfile.ts:13:a.other()\nfile.ts:14:a.method1()\n',
    stdout: 'a.Methodargument)\na.other)\nfile.ts:14:a.method1()\n',
  },
  {
    purpose: 'a two-component capture drops the call and everything after it',
    command: String.raw`sed 's/.*\(a\.[A-Za-z]*\.[A-Za-z]*\)(.*/\1/'`,
    input: 'call a.Module.Method(args); tail\na.One.Two1(args)\nunchanged\n',
    stdout: 'a.Module.Method\na.One.Two1(args)\nunchanged\n',
  },
  {
    purpose: 'a two-component capture removes a non-call suffix',
    command: String.raw`sed 's/.*\(a\.[A-Za-z]*\.[A-Za-z]*\).*/\1/'`,
    input: 'prefix a.Module.Method = 1;\na.One.Two3 + tail\na.Only\n',
    stdout: 'a.Module.Method\na.One.Two\na.Only\n',
  },
  ...['A-Za-z', 'a-zA-Z'].map(letters => ({
    purpose: `the ${letters} capture retains upper and lowercase letters`,
    command: String.raw`sed 's/.*\(a\.[${letters}]*\).*/\1/'`,
    input: 'prefix a.MixedCase42 tail\na.First; a.Last()\na.\nunchanged\n',
    stdout: 'a.MixedCase\na.Last\na.\nunchanged\n',
  })),
  {
    purpose: 'a greedy label prefix strips through the final label',
    command: "sed 's/.*b: //'",
    input: 'prefix b: one b: two\nb: value\nb:no-space\n',
    stdout: 'two\nvalue\nb:no-space\n',
  },
  {
    purpose: 'a capture replacement preserves text before the matching colon',
    command: String.raw`sed 's/:.*\(a\.[A-Za-z]*\).*/ \1/'`,
    input: 'file.ts:12:call a.Method(args)\nfile.ts:13:a.First a.Last\nno-colon a.Method\n',
    stdout: 'file.ts a.Method\nfile.ts a.Last\nno-colon a.Method\n',
  },
  {
    purpose: 'a greedy match through a literal keeps the remainder after the final match',
    command: "sed 's/:.*a/: a/'",
    input: 'file: data a.tail\nname:a value\nname:other\n',
    stdout: 'file: ail\nname: alue\nname:other\n',
  },
  {
    purpose: 'a label substitution consumes spaces but leaves tabs and later labels',
    command: "sed 's/a: *//'",
    input: 'prefix a:   value a: tail\na:value\na:\tvalue\nb: value\n',
    stdout: 'prefix value a: tail\nvalue\n\tvalue\nb: value\n',
  },
  {
    purpose: 'a simple substitution removes only the first match',
    command: "sed 's/a//'",
    input: 'banana\na\nnone\n',
    stdout: 'bnana\n\nnone\n',
  },
  {
    purpose: 'escaped pipe delimiters match literal pipes in the exact logged BRE',
    command: String.raw`sed 's|/\(a\|b\|c\|d\|e\)/.*||'`,
    input: 'root/a/file\nroot/e/file\nroot/a|b|c|d|e/file\n',
    stdout: 'root/a/file\nroot/e/file\nroot\n',
  },
  {
    purpose: 'a nonconflicting delimiter makes the listed directories BRE alternatives',
    command: String.raw`sed 's#/\(a\|b\|c\|d\|e\)/.*##'`,
    input: 'root/a/one\nroot/b/two\nroot/c/three\nroot/d/four\nroot/e/five\nroot/ab/keep\nroot/f/keep\n',
    stdout: 'root\nroot\nroot\nroot\nroot\nroot/ab/keep\nroot/f/keep\n',
  },
  {
    purpose: 'pipe delimiters allow literal slashes in the pattern',
    command: "sed 's|/a/.*||'",
    input: '/root/a/file\n/a/file\n/root/ab/file\n',
    stdout: '/root\n\n/root/ab/file\n',
  },
  {
    purpose: 'a directory capture replaces only the matching path suffix',
    command: String.raw`sed 's|/a/\([^/]*\)/.*|\1|'`,
    input: 'root/a/module/src/file.js\n/a/package/file.ts\n/a//file.ts\n/a/missing-suffix\n',
    stdout: 'rootmodule\npackage\n\n/a/missing-suffix\n',
  },
  {
    purpose: 'extended-regex mode preserves a quoted literal dot',
    command: String.raw`sed -E "s/a[0-9]*\./a./"`,
    input: 'a123.value a456.other\na.value\na123xvalue\n',
    stdout: 'a.value a456.other\na.value\na123xvalue\n',
  },
  {
    purpose: 'extended-regex mode enables unescaped groups, alternation and repetition',
    command: String.raw`sed -E 's/(a|b)[0-9]+/\1/'`,
    input: 'a12b34\nb7\nc12\na+\n',
    stdout: 'ab34\nb\nc12\na+\n',
  },
  {
    purpose: 'leading-space trimming does not remove tabs or interior spaces',
    command: "sed 's/^ *//'",
    input: '   value with spaces\n\tvalue\n \tvalue\n   \nlast',
    stdout: 'value with spaces\n\tvalue\n\tvalue\n\nlast',
  },
  {
    purpose: 'a library path suffix is removed from its first matching directory',
    command: "sed 's|/lib/.*||'",
    input: 'root/lib/source/file.js\nroot/lib/one/lib/two\nroot/library/file.js\n',
    stdout: 'root\nroot\nroot/library/file.js\n',
  },
  {
    purpose: 'a from-prefix extraction chooses the last occurrence',
    command: "sed 's/.*from //'",
    input: 'export from source from target\nfrom package\nfromage\n',
    stdout: 'target\npackage\nfromage\n',
  },
  {
    purpose: 'an escaped dot extracts the final extension rather than matching any character',
    command: String.raw`sed 's/.*\.//'`,
    input: 'src/file.test.ts\n.hidden\ntrailing.\nplain\n',
    stdout: 'ts\nhidden\n\nplain\n',
  },
  {
    purpose: 'an import-prefix extraction preserves unmatched and unterminated lines',
    command: "sed 's/.*import //'",
    input: 'prefix import one import two\nimport package\nimported\nlast',
    stdout: 'two\npackage\nimported\nlast',
  },
]

describe('sed — substitutions from agent logs', () => {
  for (const { purpose, command, input, stdout } of CASES) {
    it(purpose, () => {
      assert.deepEqual(createTerminal({ input }).run(`cat input | ${command}`), {
        stdout, stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
      }, command)
    })
  }

  it('expands the shell variable in the exact quoted prefix substitution', () => {
    const command = String.raw`f=src/file.ts; cat input | sed "s|^|$f:|"`
    assert.deepEqual(createTerminal({ input: 'one\n\nlast' }).run(command), {
      stdout: 'src/file.ts:one\nsrc/file.ts:\nsrc/file.ts:last',
      stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
  })

  it('applies both substitutions before sorting and counting the exact grep pipeline', () => {
    const files = {
      'b/x/alpha/one.js': 'a\nnone\na\n',
      'b/x/alpha/two.js': 'a\n',
      'b/x/beta/one.js': 'a\n',
      'b/nested/x/beta/two.js': 'a\n',
      'b/x/empty/one.js': 'none\n',
    }
    const command = String.raw`grep -rn "a" b/ | sed 's#.*x/##; s#/[^/]*$##' | sort | uniq -c`
    assert.deepEqual(createTerminal(files).run(command), {
      stdout: '      3 alpha\n      2 beta\n',
      stderr: '', exitCode: 0, cwd: '/', notes: [], unsupported: [],
    })
  })
})
