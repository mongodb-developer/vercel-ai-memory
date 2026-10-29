import { MongoClient } from 'mongodb'
import type { DriverInfo } from 'mongodb'
import { version } from '../../package.json'
import { defineMemoryProvider } from 'eve/memory'
import type { MemoryProviderDefinition } from 'eve/memory'

import { EmbeddingAdapter } from '../embeddings'
import { MongoMemoryStore } from '../store'
import { resolveConfig } from '../config'
import type { MemoryType, MongoDBMemoryOptions } from '../types'

import { createRecallHandler } from './recall'
import { createCaptureHandler } from './capture'
import { createTools } from './tools'
import type { EveMemoryTiers, EveMongoMemoryOptions } from './types'

const DRIVER_INFO: DriverInfo = { name: 'vercel-ai-memory-eve', version }

// Eve constructs the provider several times per process, so the
// not-production-ready notice is tracked at module level and emitted only once.
let readinessNoticeShown = false

function showReadinessNotice(): void {
  if (readinessNoticeShown) return
  readinessNoticeShown = true
  // eslint-disable-next-line no-console
  console.info(
    `[mongodb-memory] The Vercel Eve provider is not yet production-ready ` +
      `and is not recommended for production use. Its API may change in a minor release.`
  )
}

/**
 * Create a MongoDB **Vercel Eve memory provider** (not yet production-ready).
 *
 * ```ts
 * import { defineMemory } from 'eve/memory'
 * import { byPrincipal } from 'eve/memory/scope'
 * import { mongodbMemory } from '@mongodb-developer/vercel-ai-memory/eve'
 *
 * export default defineMemory({
 *   scope: byPrincipal,
 *   provider: mongodbMemory({ uri: process.env.MONGODB_URI!, embedder }),
 * })
 * ```
 *
 * The adapter is a thin layer over the package's existing `MongoMemoryStore`:
 * it reuses semantic / episodic / procedural storage, embeddings (client or
 * Atlas Automated Embedding), Atlas Vector Search, retention, and forgetting.
 * Eve owns the session/runtime lifecycle, so the adapter disables the
 * session + scratchpad tiers.
 *
 * **Security:** every read and write is partitioned by the trusted
 * `ctx.memory.scope.key` supplied by Eve — the model never provides the owner.
 */
export function mongodbMemory(
  options: EveMongoMemoryOptions
): MemoryProviderDefinition {
  showReadinessNotice()

  const tiers: Required<EveMemoryTiers> = {
    semantic: options.memory?.semantic ?? true,
    episodic: options.memory?.episodic ?? true,
    procedural: options.memory?.procedural ?? true,
  }

  const capture = options.capture ?? 'automatic'

  // Eve owns session lifecycle → always disable session + scratchpad. Also
  // disable any durable tier the caller turned off. This is Eve-adapter-only
  // and does not affect the root AI SDK integration's defaults.
  const disable: MemoryType[] = ['session', 'scratchpad']
  if (!tiers.semantic) disable.push('semantic')
  if (!tiers.episodic) disable.push('episodic')
  if (!tiers.procedural) disable.push('procedural')

  const recallLimit = options.recall?.limit ?? 5
  const recall = {
    limit: recallLimit,
    minSimilarity: options.recall?.minSimilarity ?? 0,
  }

  // Map Eve options onto the existing package configuration. Reuse resolveConfig
  // so all defaults, validation, and behavior match the core implementation.
  const coreOptions: MongoDBMemoryOptions = {
    uri: options.uri,
    embedder: options.embedder,
    autoEmbed: options.autoEmbed,
    topology: {
      dbName: options.dbName,
      disable,
    },
    retention: options.retention,
    defaults: {
      searchLimit: recallLimit,
    },
  }

  // Eve owns session/scratchpad; disabling them here is by design, so suppress
  // the "memory type disabled" operator notice (it fires once per provider
  // construction and Eve constructs the provider several times per process).
  const config = resolveConfig(coreOptions, { quietDisabledNotices: true })

  const client = new MongoClient(options.uri, {
    appName: 'devrel-integration-memory-vercel-eve-typescript',
    driverInfo: DRIVER_INFO,
  })
  const adapter = new EmbeddingAdapter(options.embedder ?? null)
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

  const recallHandler = createRecallHandler({
    store,
    tiers,
    recall,
    ensureConnected,
  })

  const definition: MemoryProviderDefinition = {
    recall: {
      'turn.started': recallHandler,
    },
    tools: createTools({ store, tiers, ensureConnected }),
  }

  if (capture === 'automatic') {
    definition.capture = {
      'turn.completed': createCaptureHandler({
        store,
        tiers,
        captureModel: options.captureModel,
        ensureConnected,
      }),
    }
  }
  // capture === 'agent' → tools only (no capture handler)
  // capture === false   → recall only (tools still exposed; no capture handler)

  return defineMemoryProvider(definition)
}

/** Alias — some Eve examples prefer `mongodb(...)` as the provider name. */
export { mongodbMemory as mongodb }
