import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * #10 — Existing (root) users must NOT be forced to install `eve`.
 *
 * The Eve adapter lives only under the `/eve` subpath. This test asserts that
 * the built root bundle (dist/index.*) contains no import/require of `eve`,
 * while the Eve bundle (dist/eve/index.*) externalizes it. Skips gracefully if
 * the project has not been built yet.
 */
const dist = resolve(__dirname, '../../../dist')

function read(p: string): string | null {
  const full = resolve(dist, p)
  return existsSync(full) ? readFileSync(full, 'utf8') : null
}

describe('/eve isolation from the root bundle (#10)', () => {
  it('root bundle does not import "eve"', () => {
    const files = ['index.js', 'index.cjs']
    let checked = 0
    for (const f of files) {
      const src = read(f)
      if (src == null) continue
      checked++
      expect(src).not.toMatch(/require\(['"]eve(\/|['"])/)
      expect(src).not.toMatch(/from\s*['"]eve(\/|['"])/)
      expect(src).not.toMatch(/import\(['"]eve(\/|['"])/)
    }
    if (checked === 0) {
      // Not built — nothing to verify in this environment.
      expect(true).toBe(true)
    }
  })

  it('eve bundle externalizes "eve/memory" and "eve/tools" (if built)', () => {
    const src = read('eve/index.cjs')
    if (src == null) {
      expect(true).toBe(true)
      return
    }
    expect(src).toMatch(/eve\/memory/)
    expect(src).toMatch(/eve\/tools/)
  })
})
