import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal } from '@preventive/terminal'

const FILES = {
  'src/Alpha.JS': 'alpha\n',
  'src/beta.js': 'beta\n',
  'src/charlie.Js': 'charlie\n',
  'src/deep/README.MD': 'readme\n',
  'src/.HIDDEN.JS': 'hidden\n',
  'src/[b].Js': 'brackets\n',
  'src/skip1.TS': 'one\n',
  'src/skip2.ts': 'two\n',
  'src/skip3.ts': 'three\n',
  'NODE_MODULES/vendor.JS': 'dependency\n',
}
const JS_PATHS = 'src/.HIDDEN.JS\nsrc/Alpha.JS\nsrc/[b].Js\nsrc/beta.js\nsrc/charlie.Js\n'
const CASES = [
  ['find src -type f -iname "*.js" | sort', JS_PATHS],
  ['find src -iname alpha.js', 'src/Alpha.JS\n'],
  ['find src -iname ".hidden.*"', 'src/.HIDDEN.JS\n'],
  ['find src -iname "[a-b]*.js" | sort', 'src/Alpha.JS\nsrc/beta.js\n'],
  ['find src -iname "skip?.ts" | sort', 'src/skip1.TS\nsrc/skip2.ts\nsrc/skip3.ts\n'],
  ['find src -iname "skip[!12].ts"', 'src/skip3.ts\n'],
  [String.raw`find src -iname '\[b\].js'`, 'src/[b].Js\n'],
  ['find . -iname node_modules -prune -o -type f -iname "*.js" -print | sort',
    JS_PATHS.replace(/^src\//gmu, './src/')],
  ['find src -type f -iname "[[:upper:]]*" | sort', 'src/Alpha.JS\nsrc/deep/README.MD\n'],
  ['find src -type f -iname "[[:lower:]]*.js" | sort', 'src/beta.js\nsrc/charlie.Js\n'],
  ['find src -type f -iname "[![:lower:]]*.js" | sort', 'src/.HIDDEN.JS\nsrc/Alpha.JS\nsrc/[b].Js\n'],
  ['find src -type f -iname "[[:upper:]b]*.js" | sort', 'src/Alpha.JS\nsrc/beta.js\n'],
  ['find src -type f -iname "[[:lower:]A]*.js" | sort', 'src/Alpha.JS\nsrc/beta.js\nsrc/charlie.Js\n'],
]

function virtual(command) {
  const r = createTerminal(FILES).run(command)
  assert.deepEqual(r.unsupported, [], command)
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode }
}

describe('find -iname — source-tree matching regressions', () => {
  for (const [command, stdout] of CASES) {
    it(command, () => assert.deepEqual(virtual(command), { stdout, stderr: '', exitCode: 0 }))
  }
})
