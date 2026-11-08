/**
 * Integration — embedding-mode index mismatch (#11).
 *
 * Exercises `_createVectorIndex` against REAL Atlas `listSearchIndexes`
 * responses (the unit tests mock that shape):
 *
 *   1. Client-mode bootstrap creates a `vector` index.
 *   2. Auto-embed bootstrap on the same db throws and leaves the index alone.
 *   3. With `recreateMismatchedIndex: true` the `vector` index is dropped.
 *   4. If Voyage AI is enabled (the `autoEmbed` index gets created), the reverse
 *      direction (client mode over an `autoEmbed` index) also throws.
 *
 * Steps 1–3 need no Voyage AI: the mismatch check runs before any `autoEmbed`
 * index would be created, so it works on the local Atlas image used in CI.
 *
 * Only the semantic type is enabled to keep it to a single search index.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoClient } from 'mongodb'
import { MongoMemoryStore } from '../../src/store'
import { resolveConfig } from '../../src/config'
import { EmbeddingAdapter } from '../../src/embeddings'
import { mockEmbedder } from '../helpers/mock-embedder'
import { ATLAS_URI } from '../helpers/atlas-client'

const DB = 'agent_memory_mismatch_test'
const COLLECTION = 'semantic_memory'
const INDEX = 'semantic_vector_index'
const DISABLED = ['session', 'procedural', 'episodic', 'scratchpad'] as const

let client: MongoClient

/** Drop the test collection (and with it the search index). Not-found is fine. */
async function dropCollection() {
  await client.db(DB).collection(COLLECTION).drop().catch((e: { code?: number }) => {
    if (e?.code !== 26) throw e
  })
}

function clientStore() {
  const config = resolveConfig({
    uri: ATLAS_URI!,
    embedder: mockEmbedder,
    topology: { dbName: DB, disable: [...DISABLED] },
  }, { quietDisabledNotices: true })
  return new MongoMemoryStore(client, new EmbeddingAdapter(mockEmbedder), config)
}

function autoStore(recreateMismatchedIndex?: boolean) {
  const config = resolveConfig({
    uri: ATLAS_URI!,
    autoEmbed: { model: 'voyage-4' },
    recreateMismatchedIndex,
    topology: { dbName: DB, disable: [...DISABLED] },
  }, { quietDisabledNotices: true })
  return new MongoMemoryStore(client, new EmbeddingAdapter(null), config)
}

/** The vector-field type of the index as Atlas reports it, or null if absent. */
async function indexType(): Promise<string | null> {
  const list = await client.db(DB).collection(COLLECTION).listSearchIndexes(INDEX).toArray()
  const idx = list.find((i) => i.name === INDEX) as Record<string, any> | undefined
  if (!idx) return null
  const fields = (idx.latestDefinition ?? idx.definition)?.fields ?? []
  return fields.find((f: any) => f.type === 'vector' || f.type === 'autoEmbed')?.type ?? null
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await pred()) return true
    await new Promise((r) => setTimeout(r, 3_000))
  }
  return false
}

const suite = ATLAS_URI ? describe : describe.skip

suite('embedding-mode index mismatch (real Atlas)', () => {
  beforeAll(async () => {
    client = new MongoClient(ATLAS_URI!, { appName: 'vercel-ai-memory-mismatch-test' })
    await client.connect()
    await dropCollection()
    await waitFor(async () => (await indexType().catch(() => null)) === null, 60_000)
  }, 120_000)

  afterAll(async () => {
    if (!client) return
    await dropCollection().catch(() => {})
    await client.close()
  })

  it('client-mode bootstrap creates a "vector" index', async () => {
    await clientStore().bootstrap()
    expect(await waitFor(async () => (await indexType()) === 'vector', 60_000)).toBe(true)
  }, 90_000)

  it('auto-embed bootstrap over a "vector" index throws and does not drop it', async () => {
    const err = await autoStore().bootstrap().then(
      () => null,
      (e: Error) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain(`Vector index "${INDEX}" on "${COLLECTION}"`)
    expect(err!.message).toContain('type "vector"')
    expect(err!.message).toContain('"autoEmbed" mode')
    expect(err!.message).toContain('Refusing to drop it')

    // Give Atlas a moment, then confirm the index is still the original one.
    await new Promise((r) => setTimeout(r, 5_000))
    expect(await indexType()).toBe('vector')
  }, 60_000)

  let autoEmbedCreated = false

  it('with recreateMismatchedIndex: true the "vector" index is replaced', async () => {
    await expect(autoStore(true).bootstrap()).resolves.toBeUndefined()
    // Drop is async on Atlas. The old index must go away; the autoEmbed one
    // only appears when Voyage AI is enabled for the org.
    const replaced = await waitFor(async () => (await indexType()) !== 'vector')
    expect(replaced).toBe(true)
    autoEmbedCreated = (await indexType()) === 'autoEmbed'
    if (!autoEmbedCreated) {
      console.warn(
        '[test] autoEmbed index not created (Voyage AI likely not enabled); ' +
          'skipping the reverse-direction check.'
      )
    }
  }, 150_000)

  it('client-mode bootstrap over an "autoEmbed" index throws (needs Voyage AI)', async (ctx) => {
    if (!autoEmbedCreated) ctx.skip()
    await expect(clientStore().bootstrap()).rejects.toThrow(/type "autoEmbed".*"vector" mode/s)
    expect(await indexType()).toBe('autoEmbed')
  }, 60_000)
})
