import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

// What npm publishes, `files` and package.json, is printable ASCII and
// newlines alone: no tab, no carriage return, no other control, nothing
// past U+007E. No file then needs an encoding to be read, and none can hide
// a bidirectional override or a lookalike letter. A comment says it in
// ASCII; a string or regexp that needs a character writes it as a \u escape.
describe('the package ships printable ASCII alone', () => {
  const dir = new URL('../', import.meta.url)
  const published = JSON.parse(readFileSync(new URL('package.json', dir), 'utf8')).files

  for (const name of ['package.json', ...published]) {
    it(`${name} is printable ASCII`, () => {
      const text = readFileSync(new URL(name, dir), 'utf8')
      const at = text.search(/[^\n -~]/u)
      if (at === -1) return
      const line = text.slice(0, at).split('\n').length
      const column = at - text.lastIndexOf('\n', at - 1)
      const code = text.codePointAt(at).toString(16).toUpperCase().padStart(4, '0')
      assert.fail(`${name}:${line}:${column} has U+${code}: in a comment write it in ASCII, in code as \\u${code}`)
    })
  }
})
