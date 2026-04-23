/**
 * Vitest Global Setup
 *
 * Runs ONCE before all test files and ONCE after all test files.
 * Handles:
 *   - Bootstrap (create indexes) — once before all integration tests
 *   - Wait for Atlas vector indexes to be READY
 *   - Drop the test database and close the connection — once after everything
 *
 * Vitest v4 globalSetup expects a default export that is a function returning
 * an optional teardown function.
 */
import {
  bootstrapOnce,
  dropTestCollections,
  waitForVectorIndexes,
  teardown,
} from './atlas-client'

export default async function globalSetup() {
  console.log('\n[global-setup] Dropping test collections for clean slate...')
  await dropTestCollections()

  console.log('[global-setup] Bootstrapping test database...')
  await bootstrapOnce()
  await waitForVectorIndexes(120_000, 3_000)
  console.log('[global-setup] Bootstrap complete. Running tests...\n')

  // Return the teardown function — vitest calls this after all tests finish
  return async function globalTeardown() {
    console.log('\n[global-setup] Tearing down test database...')
    await teardown()
    console.log('[global-setup] Done.\n')
  }
}
