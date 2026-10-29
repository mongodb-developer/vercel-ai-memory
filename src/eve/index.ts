/**
 * `@mongodb-developer/vercel-ai-memory/eve`
 *
 * **Not production-ready:** not yet recommended for production use. This subpath is excluded
 * from the package's semantic-versioning guarantees and may change in a minor
 * release.
 *
 * A MongoDB **memory provider for Vercel Eve**, layered on top of
 * the package's existing MongoDB memory store. Import this subpath only in Eve
 * projects — it is fully isolated from the root AI SDK entrypoint, and `eve` is
 * an optional peer dependency.
 *
 * @example
 * ```ts
 * // agent/memory/profile.ts
 * import { defineMemory } from 'eve/memory'
 * import { byPrincipal } from 'eve/memory/scope'
 * import { mongodbMemory } from '@mongodb-developer/vercel-ai-memory/eve'
 *
 * export default defineMemory({
 *   scope: byPrincipal,
 *   provider: mongodbMemory({
 *     uri: process.env.MONGODB_URI!,
 *     embedder,
 *     capture: 'automatic',
 *   }),
 * })
 * ```
 */
export { mongodbMemory, mongodb } from './provider'

export type {
  EveMongoMemoryOptions,
  EveMemoryTiers,
  EveRecallOptions,
  EveCaptureMode,
} from './types'

// Re-export the core embedding / auto-embedding types for convenience so Eve
// users don't need to import from two subpaths.
export type { AutoEmbedOptions } from '../types'
