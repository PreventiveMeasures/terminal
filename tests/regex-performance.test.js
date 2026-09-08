import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const CASES = [
  {
    purpose: "resets cached capture state across matches and records of different lengths",
    prog: "{ print gensub(/id=([0-9]+)/, \"[\\\\1]\", \"g\") }",
    input: "id=7,id=204; id=9\nprefix id=2 trailing\nid=12345\n",
    stdout: "[7],[204]; [9]\nprefix [2] trailing\n[12345]\n",
  },
  {
    purpose: "falls back to POSIX longest captures when native alternatives stop early",
    prog: "{ print gensub(/(a|aa)/, \"<\\\\1>\", \"g\") }",
    input: "aaaa\na\nbaab\n",
    stdout: "<aa><aa>\n<a>\nb<aa>b\n",
  },
  {
    purpose: "retains original assertion context on both capture paths",
    prog: "{ print gensub(/(a|aa)\\B/, \"[\\\\1]\", \"g\") }",
    input: "aab\naa!\nbaaa\n",
    stdout: "[aa]b\n[a]a!\nb[aa]a\n",
  },
  {
    purpose: "reuses capture matching for empty captures without repeating adjacent empty replacements",
    prog: "{ print gensub(/(a*)/, \"[\\\\1]\", \"g\") }",
    input: "\naba\nbbb\n",
    stdout: "[]\n[a]b[a]\n[]b[]b[]b[]\n",
  },
  {
    purpose: "retains astral captures and optional empty groups across records",
    prog: "{ print gensub(/(😀+)(a*)/, \"[\\\\2|\\\\1]\", \"g\") }",
    input: "x😀😀aa!\n😀b\nplain\nx😀a😀aa\n",
    stdout: "x[aa|😀😀]!\n[|😀]b\nplain\nx[a|😀][aa|😀]\n",
  },
  {
    purpose: "retains capture offsets and clears omitted optional groups on later records",
    prog: "match($0, /(id=)([0-9]+)(:x)?/, m) { print m[1], m[2], m[2,\"start\"], m[2,\"length\"], \"[\" m[3] \"]\" }",
    input: "id=7:x\nid=204\nx id=9:x\n",
    stdout: "id= 7 4 1 [:x]\nid= 204 4 3 []\nid= 9 6 1 [:x]\n",
  },
  {
    purpose: "finds repeated literal grep extents after astral characters",
    command: "grep -no TODO < input",
    input: "pre😀TODO after TODO\n😀TODO\nplain\nTODO\n",
    stdout: "1:TODO\n1:TODO\n2:TODO\n4:TODO\n",
  },
  {
    purpose: "replaces multi-character literal separators without changing Unicode text",
    command: "sed 's/::/|/g' < input",
    input: "😀::a::b\n::\nplain\n",
    stdout: "😀|a|b\n|\nplain\n",
  },
  {
    purpose: "recognizes fixed literal extents through groups and exact repetitions",
    prog: "{ print gsub(/(ab){2}/, \"X\"), $0 }",
    input: "abab ab abab\nab\n\n",
    stdout: "2 X ab X\n0 ab\n0 \n",
  },
  {
    purpose: "retains the NFA path for anchored alternatives",
    prog: "{ print gsub(/^TODO|TODO$/, \"X\"), $0 }",
    input: "TODOmiddleTODO\nmiddleTODO\nTODOmiddle\nmiddle\n",
    stdout: "2 XmiddleX\n1 middleX\n1 Xmiddle\n0 middle\n",
  },
  {
    purpose: "keeps case-sensitive and IGNORECASE instances independent",
    prog: "{ IGNORECASE = NR % 2; print gsub(/todo/, \"X\"), $0 }",
    input: "TODO ToDo todo\nTODO ToDo todo\nTODO ToDo todo\n",
    stdout: "3 X X X\n1 TODO ToDo X\n3 X X X\n",
  },
  {
    purpose: "keeps empty literal matching on code-point boundaries",
    prog: "BEGIN { s=\"😀ab\"; print gsub(/()/, \"_\", s), s }",
    input: "",
    stdout: "4 _😀_a_b_\n",
  },
]

const GAPS = [
  {
    purpose: "keeps unsafe capture diagnostics after a record without a match",
    prog: "{ print gensub(/(x(y)?)+/, \"[\\\\1]\", \"g\") }",
    input: "zzz\nxyx\n",
    stdout: "zzz\n",
    detail: "regex capture semantics",
    message: "awk: capture extraction across repeated or alternative groups is not supported",
  },
  {
    purpose: "checks locale semantics after warming a capture matcher on ASCII input",
    prog: "{ print gensub(/([[:alpha:]]+)/, \"[\\\\1]\", \"g\") }",
    input: "alpha\ncafé\n",
    stdout: "[alpha]\n",
    detail: "locale-sensitive character classes",
    message: "awk: POSIX character classes on non-ASCII input require locale support",
  },
  {
    purpose: "retains the NFA state limit even for a fixed literal on empty input",
    prog: "BEGIN { s=\"\"; print gsub(/a{1000}{50}/, \"X\", s) }",
    input: "",
    stdout: "",
    detail: "regex state limit",
    message: "awk: regex too large",
  },
]

describe('regex performance paths retain matching and capture semantics', () => {
  for (const { purpose, prog = '', input, stdout, command = 'awk -f prog < input' } of CASES) {
    it(purpose, () => {
      const result = createTerminal({ prog, input }).run(command)
      assert.deepEqual(result, { stdout, stderr: '', exitCode: 0, cwd: '/', unsupported: [] })
    })
  }
  for (const { purpose, prog, input, stdout, detail, message } of GAPS) {
    it(purpose, () => {
      const terminal = createTerminal({ prog, input })
      const unsupported = [{ kind: 'feature', command: 'awk', detail, message }]
      assert.deepEqual(terminal.run('awk -f prog < input'), {
        stdout, stderr: message + '\n', exitCode: 2, cwd: '/', unsupported,
      })
      assert.deepEqual(terminal.run('awk -f prog < input 2>/dev/null | cat'), {
        stdout, stderr: '', exitCode: 0, cwd: '/', unsupported,
      })
    })
  }
})
