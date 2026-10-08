import { describe, it, expect } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import pkg from '../../package.json'

const root = resolve(__dirname, '../..')

// Release CI builds first so these checks validate the actual publish artifact.
describe.skipIf(!existsSync(resolve(root, 'dist')))('built package exports', () => {
  for (const [entry, modes] of Object.entries(pkg.exports)) {
    for (const [mode, targets] of Object.entries(modes)) {
      it(`${entry} resolves all ${mode} targets`, () => {
        for (const target of Object.values(targets)) {
          expect(existsSync(resolve(root, target)), target).toBe(true)
        }
      })
    }
  }

  it('resolves the legacy entry points', () => {
    for (const target of [pkg.main, pkg.module, pkg.types]) {
      expect(existsSync(resolve(root, target)), target).toBe(true)
    }
  })
})