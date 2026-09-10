import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { createTerminal } from '@preventive/terminal'

function check(program, stdout, files = {}, operands = '', exitCode = 0) {
  const terminal = createTerminal({ 'program.awk': program, ...files })
  assert.deepEqual(terminal.run(`awk -f program.awk ${operands}`), {
    stdout, stderr: '', exitCode, cwd: '/', notes: [], unsupported: [],
  })
}

describe('awk runtime optimization regressions', () => {
  it('resolves names in each function frame and restores recursive parameters', () => {
    check(`
      function globalValue() { return value }
      function localValue(value) { return value ":" globalValue() }
      function recurse(value) {
        if (value < 1) return localValue("leaf")
        return value ":" recurse(value - 1) ":" value
      }
      BEGIN {
        value = "global"
        print localValue("one"), localValue("two")
        print recurse(2), value
      }
    `, 'one:global two:global\n2:1:leaf:global:1:2 global\n')
  })

  it('accepts scalar and array arguments on separate calls to the same function', () => {
    check(`
      function size(value) { return length(value) }
      BEGIN {
        values[1] = "first"; values[2] = "second"
        print size("abc"), size(values), size(12345), size("")
      }
    `, '3 2 5 0\n')
  })

  it('shares an initially untyped array through separate parameter references', () => {
    check(`
      function seed(a) { a["x"] = 1 }
      function forward(a, b) {
        seed(a)
        b["y"] = 2
        a["z"] = 3
        print length(a), length(b)
      }
      BEGIN {
        forward(items, items)
        print items["x"], items["y"], items["z"]
        forward(other, other)
        delete other["x"]
        print length(items), length(other)
      }
    `, '3 3\n1 2 3\n3 3\n3 2\n')
  })

  it('evaluates incrementing array target subscripts exactly once', () => {
    check(`
      function key() { calls++; return "row" }
      BEGIN {
        i = 1; values[1] = 10; values[2] = 20
        values[i++] += 3
        ++values[i++]
        values[key(), ++column] = 5
        values[key(), column]++
        print i, values[1], values[2], calls, column, values["row", 1]
      }
    `, '3 13 21 2 1 6\n')
  })

  it('preserves integer and numeric-string keys while CONVFMT changes fractional keys', () => {
    check(`
      BEGIN {
        CONVFMT = "%.1f"
        values[-0] = "zero"
        values[9007199254740991] = "safe"
        values[9007199254740994] = "large"
        values[0.26] = "first"
        CONVFMT = "%.2f"
        values[0.26] = "second"
        print values["0"], values["9007199254740991"], values["9007199254740994"]
        print values[0], values[9007199254740991], values[9007199254740994]
        print values["0.3"], values["0.26"]
      }
      {
        values[$1] = "spelled"
        values[1] = "numeric"
        print values["01"], values["1"], ($1 == 1)
      }
    `, 'zero safe large\nzero safe large\nfirst second\nspelled numeric 1\n', { numbers: '01\n' }, 'numbers')
  })

  it('creates missing array entries without reordering repeated undefined reads', () => {
    check(`
      BEGIN {
        values["first"]; values["second"]; values["third"] = 3
        values["first"]; values["second"]
        values["new"]; values["first"]
        for (key in values) order = order "[" key "]"
        print length(values), order, ("absent" in values), length(values)
      }
    `, '4 [first][second][third][new] 0 4\n')
  })

  it('rebuilds records after compound field and NF updates', () => {
    check(`
      BEGIN {
        $0 = "10 20 30"; OFS = ":"; i = 1
        $(i++) += 5
        ++$(i++)
        print $0, NF, i
        NF--
        print $0, NF
        NF += 2
        print "[" $0 "]", NF
      }
    `, '15:21:30:3:3\n15:21:2\n[15:21::]:4\n')
  })

  it('unwinds nested function parameters across next, nextfile, and exit', () => {
    check(`
      function inner(flag, tag) {
        if (flag == "skip") next
        if (flag == "file") nextfile
        if (flag == "stop") exit 7
        return tag
      }
      function outer(flag, tag) { return inner(flag, tag) }
      BEGIN { tag = "global" }
      {
        print "before", NR, tag
        result = outer($1, "local")
        print "after", result, tag
      }
      ENDFILE { print "close", FILENAME, tag }
      END { print "end", NR, tag }
    `, [
      'before 1 global', 'before 2 global', 'after local global',
      'before 3 global', 'close a global',
      'before 4 global', 'after local global', 'before 5 global',
      'end 5 global', '',
    ].join('\n'), { a: 'skip\nkeep\nfile\nunseen\n', b: 'keep\nstop\nunseen\n' }, 'a b', 7)
  })
})
