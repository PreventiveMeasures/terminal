import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

// npm, unlike pnpm, packs a LICENSE-MIT only when `files` names it, so
// without the listing an `npm publish` would ship no license text at all.
describe('the package ships both license texts', () => {
  it('declares the dual license', () => {
    assert.equal(pkg.license, 'MIT OR Apache-2.0')
  })

  for (const name of ['LICENSE-APACHE', 'LICENSE-MIT']) {
    it(`files includes ${name}`, () => {
      assert.ok(pkg.files.includes(name), `${name} is not in package.json files, so npm would publish without it`)
      assert.ok(existsSync(new URL(`../${name}`, import.meta.url)), `${name} is in package.json files but not in the package`)
    })
  }
})
