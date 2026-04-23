import { MongoClient } from 'mongodb'
import { EmbeddingAdapter } from './embeddings'
import { MongoMemoryStore } from './store'
import { buildMemoryTool } from './tool'
import { resolveConfig } from './config'
import type {
  MongoDBMemoryOptions,
  MemoryCallOptions,
  MemoryConfig,
} from './types'

export type { MongoDBMemoryOptions, MemoryCallOptions }
export type {
  UsageStats,
  SessionMemory,
  SemanticMemory,
  ProceduralMemory,
  EpisodicMemory,
  ScratchpadMemory,
  MemoryType,
  VectorMemoryType,
  VectorSimilarity,
  DecayPolicy,
  DecayInput,
  TopologyOptions,
  RetentionOptions,
  FilteringOptions,
  DefaultsOptions,
  MemoryConfig,
} from './types'
export { MongoMemoryStore } from './store'
export { EmbeddingAdapter } from './embeddings'
export { buildMemoryTool } from './tool'
export { resolveConfig } from './config'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * The object returned by `createMongoDBMemory()`.
 *
 * It is callable: `mongodbMemory({ userId, sessionId })` returns a tools record
 * that can be passed directly to `ToolLoopAgent`:
 *
 * ```ts
 * tools: mongodbMemory({ userId, sessionId })
 * ```
 */
export interface MongoDBMemoryInstance {
  /**
   * Returns a tools record scoped to the given userId and sessionId.
   * Pass directly to `tools:` in your agent configuration.
   *
   * @example
   * ```ts
   * const agent = new ToolLoopAgent({
   *   model: openai('gpt-4.1'),
   *   tools: mongodbMemory({ userId: 'alice', sessionId: 'sess-001' }),
   * })
   * ```
   */
  (options?: MemoryCallOptions): Record<string, ReturnType<typeof buildMemoryTool>>

  /** The underlying MongoMemoryStore for advanced / direct access */
  store: MongoMemoryStore

  /** The fully-resolved MemoryConfig (defaults applied). */
  config: MemoryConfig

  /**
   * Explicitly connect to MongoDB and run bootstrap (creates indexes).
   * Called automatically on first tool use if not called manually.
   */
  connect(): Promise<void>

  /** Gracefully close the MongoDB connection */
  close(): Promise<void>
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Creates a MongoDB-backed memory provider for the Vercel AI SDK.
 *
 * The returned instance is a **callable function** — invoke it per-request to
 * get a tools record scoped to a `userId` and `sessionId`:
 *
 * ```ts
 * // Once at module level:
 * const mongodbMemory = createMongoDBMemory({
 *   uri: process.env.MONGODB_URI!,
 *   embedder: openai.embedding('text-embedding-3-small'),
 * })
 *
 * // Per request:
 * const agent = new ToolLoopAgent({
 *   model: openai('gpt-4.1'),
 *   tools: mongodbMemory({ userId: 'alice', sessionId: 'sess-001' }),
 * })
 * ```
 *
 * Supports all Vercel AI SDK `EmbeddingModel` providers (OpenAI, Cohere, Google, etc.).
 * Embedding dimensions are auto-detected on first use — no manual configuration needed.
 *
 * @param options - Configuration options (see {@link MongoDBMemoryOptions}).
 */
export function createMongoDBMemory(options: MongoDBMemoryOptions): MongoDBMemoryInstance {
  const config = resolveConfig(options)

  const client = new MongoClient(options.uri, {
    appName: 'devrel-integration-memory-vercel-typescript',
  })
  const adapter = new EmbeddingAdapter(options.embedder)
  const store = new MongoMemoryStore(client, adapter, config)

  let bootstrapped = false
  let bootstrapPromise: Promise<void> | null = null

  async function ensureConnected(): Promise<void> {
    if (bootstrapped) return
    if (bootstrapPromise) return bootstrapPromise

    bootstrapPromise = (async () => {
      await client.connect()
      await store.bootstrap()
      bootstrapped = true
    })()

    return bootstrapPromise
  }

  // ── The callable function ──────────────────────────────────────────────────
  function memoryInstance(callOptions?: MemoryCallOptions) {
    const userId = callOptions?.userId ?? config.defaultUserId
    const sessionId = callOptions?.sessionId ?? config.defaultSessionId

    // Pass ensureConnected as the onBeforeExecute hook for lazy bootstrap.
    // The config lets the tool tailor its command enum to the enabled types.
    const memoryTool = buildMemoryTool(store, userId, sessionId, ensureConnected, config)

    return { memory: memoryTool }
  }

  // ── Attach extra methods ────────────────────────────────────────────────────
  memoryInstance.store = store
  memoryInstance.config = config

  memoryInstance.connect = async (): Promise<void> => {
    await ensureConnected()
  }

  memoryInstance.close = async (): Promise<void> => {
    await client.close()
    bootstrapped = false
    bootstrapPromise = null
  }

  return memoryInstance as MongoDBMemoryInstance
}
