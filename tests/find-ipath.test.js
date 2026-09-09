import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'APP/.Hidden.Js': '',
  'APP/Alpha.TS': 'alpha\n',
  'APP/[x].TS': '',
  'APP/deep/Beta.ts': 'beta\n',
  'APP/node_modules/dep.TS': '',
  'APP/space name.ts': '',
  'Other/Test.ts': '',
}
const TYPESCRIPT = 'APP/Alpha.TS\nAPP/[x].TS\nAPP/deep/Beta.ts\nAPP/node_modules/dep.TS\nAPP/space name.ts\n'
const SOURCES = 'APP/Alpha.TS\nAPP/[x].TS\nAPP/deep/Beta.ts\nAPP/space name.ts\n'

function check(command, stdout, files = FILES) {
  const result = createTerminal(files).run(command)
  assert.deepEqual([result.stdout, result.stderr, result.exitCode, result.unsupported], [stdout, '', 0, []], command)
}

describe('find -ipath case-insensitive full paths', () => {
  for (const [command, stdout] of [
    ['find APP -type f -ipath "app/*.ts" | sort', TYPESCRIPT],
    ['find APP -ipath "APP/ALPHA.TS"', 'APP/Alpha.TS\n'],
    ['find APP -path "APP/ALPHA.TS"', ''],
    ['find APP -ipath "ALPHA.TS"', ''],
    ['find APP -iname "ALPHA.TS"', 'APP/Alpha.TS\n'],
    ['find APP -ipath "*HIDDEN.JS"', 'APP/.Hidden.Js\n'],
    ['find APP -ipath "APP/*BETA.TS"', 'APP/deep/Beta.ts\n'],
    ['find APP -ipath "*/[a-b]*.ts"', 'APP/Alpha.TS\nAPP/deep/Beta.ts\n'],
    ['find APP -ipath "*/[[:upper:]]*.ts"', 'APP/Alpha.TS\nAPP/deep/Beta.ts\n'],
    [String.raw`find APP -ipath 'app/\[X\].ts'`, 'APP/[x].TS\n'],
    ['find APP -ipath "app/SPACE?NAME.TS"', 'APP/space name.ts\n'],
    ['find APP -ipath ""', ''],
    ['find APP/ -ipath "app/"', 'APP/\n'],
    ['find APP -ipath "app/*/"', ''],
    ['find APP//deep/ -ipath "app//deep/beta.ts"', 'APP//deep/Beta.ts\n'],
    ['find ./APP -ipath "./app/alpha.ts"', './APP/Alpha.TS\n'],
    ['find /APP -ipath "/app/alpha.ts"', '/APP/Alpha.TS\n'],
    ['find APP -ipath "/app/alpha.ts"', ''],
    ['cd APP && find . -ipath "./DEEP/BETA.TS"', './deep/Beta.ts\n'],
    ['find APP Other -ipath "*/BETA.TS" -o -ipath "other/test.TS"', 'APP/deep/Beta.ts\nOther/Test.ts\n'],
    ['find APP -maxdepth 1 -ipath "*.ts" | sort', 'APP/Alpha.TS\nAPP/[x].TS\nAPP/space name.ts\n'],
  ]) {
    it(command, () => check(command, stdout))
  }

  it('combines pruning, basename matching, and negation', () => {
    check('find APP -ipath "*/NODE_MODULES" -prune -o -type f -iname "*.ts" -print | sort', SOURCES)
    check('find APP -type f -iname "*.ts" ! -ipath "*/NODE_MODULES/*" | sort', SOURCES)
    check('find APP -type f -iname "*.ts" -not -ipath "*/NODE_MODULES/*" | sort', SOURCES)
  })

  it('composes grouped predicates and execution actions', () => {
    check(String.raw`find APP -type f \( -ipath '*/ALPHA.TS' -o -ipath '*/BETA.TS' \)`, 'APP/Alpha.TS\nAPP/deep/Beta.ts\n')
    check('find APP -ipath "*/ALPHA.TS" -exec cat {} +', 'alpha\n')
    check('find APP -ipath "*/ALPHA.TS" -print0 | xargs -0 cat', 'alpha\n')
  })

  it('validates roots case-sensitively and missing values as ordinary errors', () => {
    for (const command of ['find app -ipath "*.ts"', 'find APP -ipath', 'find APP ! -ipath']) {
      const result = createTerminal(FILES).run(command)
      assert.notEqual(result.exitCode, 0)
      assert.notEqual(result.stderr, '')
      assert.deepEqual(result.unsupported, [])
    }
  })
})

describe('find -ipath unavailable glob semantics stay diagnostic', () => {
  for (const [command, files, detail] of [
    ['find . -ipath "*.ts"', { 'café/Alpha.TS': '' }, 'non-ASCII glob matching'],
    ['LC_ALL=C find . -ipath "*.ts"', { 'café/Alpha.TS': '' }, 'non-ASCII glob matching'],
    ['find . -ipath "*CAFÉ*"', { 'ascii/Alpha.TS': '' }, 'non-ASCII glob matching'],
    ["find APP -ipath '*[[=a=]]*'", FILES, 'glob collating or equivalence class'],
    ["find APP -ipath '*[[.a.]]*'", FILES, 'glob collating or equivalence class'],
  ]) {
    it(command, () => {
      const direct = createTerminal(files).run(command)
      const hidden = createTerminal(files).run(command + ' 2>/dev/null | cat')
      assert.notEqual(direct.exitCode, 0)
      assert.notEqual(direct.stderr, '')
      assert.deepEqual(direct.unsupported.map((note) => [note.command, note.detail]), [['find', detail]])
      assert.deepEqual(hidden.unsupported, direct.unsupported)
      assert.equal(hidden.stderr, '')
    })
  }

  it('does not evaluate unsupported matching in an unreached predicate', () => {
    check('find . -prune -o -ipath "*É*"', '.\n', { 'café/Alpha.TS': '' })
    check('find . -ipath "*/SKIP" -prune -o -type f -iname "*.ts" -print', '', { 'skip/café.TS': '' })
  })
})
