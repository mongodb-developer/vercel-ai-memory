import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoClient } from 'mongodb'
import { MongoMemoryStore } from '../../src/store'
import { EmbeddingAdapter } from '../../src/embeddings'
import { buildMemoryTool } from '../../src/tool'
import { resolveConfig } from '../../src/config'
import { ATLAS_URI } from '../helpers/atlas-client'
import type { MemoryConfig } from '../../src/types'

/**
 * Atlas Automated Embedding — ROOT AI SDK integration (NOT the /eve adapter).
 *
 * Proves the legacy `createMongoDBMemory` path works end-to-end with
 * `autoEmbed: { model: 'voyage-4' }`:
 *   1. bootstrap emits `type:"autoEmbed"` indexes (path `embed_text`, model `voyage-4`)
 *   2. *Save writes `embed_text` and NO client `embedding` array
 *   3. *Search returns relevant docs via server-side (Voyage) embeddings
 *   4. the AI SDK `memory` tool (buildMemoryTool) works in auto-embed mode
 *
 * Isolation: this test uses its OWN client + a SEPARATE database so its
 * `type:"autoEmbed"` indexes never collide with the client-mode
 * `type:"vector"` indexes the shared helper bootstraps in global-setup
 * (same index name + different field type would trigger the store's
 * self-heal drop/recreate — we avoid that churn entirely).
 *
 * Gating:
 *   - The whole suite is skipped when `MONGODB_URI` is unset.
 *   - Atlas Automated Embedding is a Preview feature that requires Voyage AI
 *     enabled for the org. If the `autoEmbed` index never reaches READY (e.g.
 *     Voyage AI is not enabled, so `createSearchIndexes` failed — the store
 *     logs `[mongodb-memory] Failed to create vector index ...`), the
 *     index + search assertions are skipped with a clear reason. The
 *     persistence + tool-save tests still run because they don't depend on the
 *     server-side index being queryable.
 */

// A dedicated database so we never touch the shared `agent_memory_test` db.
const AUTO_DB = 'agent_memory_autoembed_test'
const AUTO_MODEL = 'voyage-4'
const USER = 'test-user-autoembed'

const VECTOR_COLLECTIONS = ['semantic_memory', 'procedural_memory', 'episodic_memory'] as const
const VECTOR_INDEXES = [
  'semantic_vector_index',
  'procedural_vector_index',
  'episodic_vector_index',
] as const

let client: MongoClient
let store: MongoMemoryStore
let config: MemoryConfig
/** True once ALL three autoEmbed indexes reach READY (i.e. Voyage AI is enabled). */
let voyageReady = false


/** Poll a single search index until READY (or timeout). Returns the READY def or null. */
async function waitForAutoEmbedIndex(
  collection: string,
  indexName: string,
  timeoutMs = 120_000,
  pollMs = 3_000
): Promise<Record<string, unknown> | null> {
  const db = client.db(AUTO_DB)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const indexes = await db.collection(collection).listSearchIndexes(indexName).toArray()
      const idx = indexes.find((i: { name: string }) => i.name === indexName) as
        | Record<string, unknown>
        | undefined
      if (idx && (idx as { status?: string }).status === 'READY') return idx
    } catch {
      // introspection can transiently fail while Atlas provisions — keep polling
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return null
}

/** Retry a search a few times to absorb async server-side embedding lag. */
async function searchWithRetry<T>(
  fn: () => Promise<T[]>,
  predicate: (results: T[]) => boolean,
  attempts = 8,
  delayMs = 3_000
): Promise<T[]> {
  let last: T[] = []
  for (let i = 0; i < attempts; i++) {
    last = await fn()
    if (predicate(last)) return last
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return last
}

const suite = ATLAS_URI ? describe : describe.skip

suite('Atlas Automated Embedding — root AI SDK integration', () => {
  beforeAll(async () => {
    client = new MongoClient(ATLAS_URI!, {
      appName: 'devrel-integration-memory-vercel-typescript',
    })
    await client.connect()

    // Clean slate for DATA, but keep the collections (and therefore their
    // `autoEmbed` search indexes) alive across runs. Dropping the collection
    // would wipe the indexes and force Atlas to rebuild them from scratch on
    // every run (~40s+ of async provisioning, longer for autoEmbed because the
    // Voyage pipeline must be set up too). With deleteMany the indexes are
    // already READY on re-runs. If a stale index of the wrong type is ever left
    // behind, bootstrap throws (see index-mismatch.test.ts); drop the collection.
    const db = client.db(AUTO_DB)
    for (const name of VECTOR_COLLECTIONS) {
      await db.collection(name).deleteMany({}).catch(() => {
        // collection may not exist yet on first run — fine
      })
    }

    // Build a store in AUTO-EMBED mode (null client embedder — Atlas embeds
    // server-side). Isolated db keeps default collection/index names but in a
    // separate namespace from the client-mode helper store.
    config = resolveConfig({ uri: ATLAS_URI!, dbName: AUTO_DB, autoEmbed: { model: AUTO_MODEL } })
    store = new MongoMemoryStore(client, new EmbeddingAdapter(null), config)

    await store.bootstrap()

    // Wait for every autoEmbed index to be READY. If any never becomes READY,
    // Voyage AI is almost certainly not enabled for this org — gate the
    // search/index tests accordingly rather than failing the suite.
    const readied = await Promise.all(
      VECTOR_COLLECTIONS.map((c, i) => waitForAutoEmbedIndex(c, VECTOR_INDEXES[i]))
    )
    voyageReady = readied.every((idx) => idx !== null)

    if (!voyageReady) {
      console.warn(
        '\n[test] ⚠️  Atlas Automated Embedding indexes did not reach READY.\n' +
          '[test]     This usually means Voyage AI / Automated Embedding (Preview) is\n' +
          '[test]     not enabled for this org. Skipping index + search assertions.\n'
      )
    } else {
      console.log('[test] ✅ autoEmbed indexes READY on db:', AUTO_DB)
    }
  }, 180_000)

  afterAll(async () => {
    if (client) {
      try {
        const db = client.db(AUTO_DB)
        for (const name of VECTOR_COLLECTIONS) {
          await db.collection(name).deleteMany({}).catch(() => {})
        }
      } catch {
        // best-effort cleanup
      }
      await client.close()
    }
  })

  // ── 1. Index shape ──────────────────────────────────────────────────────────
  it('bootstraps type:"autoEmbed" indexes (model voyage-4, path embed_text)', async () => {
    if (!voyageReady) {
      console.warn('[test] Skipped — autoEmbed indexes not READY (Voyage AI not enabled?).')
      return
    }
    const db = client.db(AUTO_DB)
    for (let i = 0; i < VECTOR_COLLECTIONS.length; i++) {
      const indexes = await db
        .collection(VECTOR_COLLECTIONS[i])
        .listSearchIndexes(VECTOR_INDEXES[i])
        .toArray()
      const idx = indexes.find((x: { name: string }) => x.name === VECTOR_INDEXES[i]) as
        | Record<string, unknown>
        | undefined
      expect(idx, `${VECTOR_INDEXES[i]} should exist`).toBeTruthy()

      const def = ((idx!.latestDefinition ?? idx!.definition) ?? {}) as {
        fields?: Array<{ type?: string; path?: string; model?: string; modality?: string }>
      }
      const vf = def.fields?.find((f) => f.type === 'autoEmbed')
      expect(vf, `${VECTOR_INDEXES[i]} should have an autoEmbed field`).toBeTruthy()
      expect(vf!.path).toBe('embed_text')
      expect(vf!.model).toBe(AUTO_MODEL)
      expect(vf!.modality).toBe('text')
    }
  })

  // ── 2. Saves write embed_text and NO client embedding array ──────────────────
  it('semanticSave writes embed_text (no embedding array)', async () => {
    await store.semanticSave(USER, 'Alex', 'Loves rock climbing and specialty coffee', {
      importance: 8,
      tags: ['preference', 'outdoor'],
    })
    const doc = (await client
      .db(AUTO_DB)
      .collection('semantic_memory')
      .findOne({ user_id: USER, name: 'Alex', is_latest: true })) as Record<string, unknown> | null
    expect(doc).not.toBeNull()
    expect(typeof doc!.embed_text).toBe('string')
    expect(doc!.embed_text as string).toContain('Alex')
    expect(doc!.embedding).toBeUndefined()
  })

  it('proceduralSave writes embed_text (no embedding array)', async () => {
    await store.proceduralSave(USER, 'Deploy service', 'Run terraform apply then smoke tests', {
      importance: 7,
    })
    const doc = (await client
      .db(AUTO_DB)
      .collection('procedural_memory')
      .findOne({ user_id: USER, task: 'Deploy service', is_latest: true })) as Record<
      string,
      unknown
    > | null
    expect(doc).not.toBeNull()
    expect(typeof doc!.embed_text).toBe('string')
    expect(doc!.embedding).toBeUndefined()
  })

  it('episodicSave writes embed_text (no embedding array)', async () => {
    const id = await store.episodicSave(USER, 'purchase', 'Bought a new climbing harness', {
      importance: 6,
    })
    const doc = (await client
      .db(AUTO_DB)
      .collection('episodic_memory')
      .findOne({ _id: id })) as Record<string, unknown> | null
    expect(doc).not.toBeNull()
    expect(typeof doc!.embed_text).toBe('string')
    expect(doc!.embedding).toBeUndefined()
  })


  // ── 3. Server-side semantic search ranks relevant docs ───────────────────────
  it('semanticSearch returns the relevant doc via server-side embeddings', async () => {
    if (!voyageReady) {
      console.warn('[test] Skipped — autoEmbed indexes not READY (Voyage AI not enabled?).')
      return
    }
    // Seed a couple of distinct facts so ranking is meaningful.
    await store.semanticSave(USER, 'Alex', 'Loves rock climbing and specialty coffee', {
      importance: 8,
    })
    await store.semanticSave(USER, 'Sam', 'Prefers tea and quiet libraries', { importance: 5 })

    const results = await searchWithRetry(
      () => store.semanticSearch(USER, 'outdoor climbing hobby', 5),
      (r) => r.some((d) => d.name === 'Alex')
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((d) => d.name === 'Alex')).toBe(true)
  }, 60_000)

  it('proceduralSearch returns the relevant doc via server-side embeddings', async () => {
    if (!voyageReady) {
      console.warn('[test] Skipped — autoEmbed indexes not READY (Voyage AI not enabled?).')
      return
    }
    await store.proceduralSave(USER, 'Deploy service', 'Run terraform apply then smoke tests', {
      importance: 7,
    })
    const results = await searchWithRetry(
      () => store.proceduralSearch(USER, 'how to deploy infrastructure', 5),
      (r) => r.some((d) => d.task === 'Deploy service')
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((d) => d.task === 'Deploy service')).toBe(true)
  }, 60_000)

  it('episodicSearch returns the relevant doc via server-side embeddings', async () => {
    if (!voyageReady) {
      console.warn('[test] Skipped — autoEmbed indexes not READY (Voyage AI not enabled?).')
      return
    }
    await store.episodicSave(USER, 'purchase', 'Bought a new climbing harness', { importance: 6 })
    const results = await searchWithRetry(
      () => store.episodicSearch(USER, 'shopping for climbing gear', 5),
      (r) => r.some((d) => d.description.includes('climbing harness'))
    )
    expect(results.length).toBeGreaterThan(0)
    expect(results.some((d) => d.description.includes('climbing harness'))).toBe(true)
  }, 60_000)

  // ── 3b. Forced, scoped retrieval — relevance AND isolation ────────────────────
  //
  // The agent examples can't *force* a retrieve (recall is LLM-driven), so this
  // proves the store-level contract directly in auto-embed mode: a scoped
  // `*Search(userId, …)` returns the querying user's relevant doc and NEVER
  // another user's. This is the auto-embed analogue of the Eve scope test
  // (tests/integration/eve/scope.test.ts) — but because Atlas/Voyage embeddings
  // rank meaningfully (unlike the mock embedder), we can assert relevance too.
  it('scoped search returns the right doc for each user and never leaks across users', async () => {
    if (!voyageReady) {
      console.warn('[test] Skipped — autoEmbed indexes not READY (Voyage AI not enabled?).')
      return
    }
    const ALICE = 'test-autoembed-alice'
    const BOB = 'test-autoembed-bob'

    await store.semanticSave(ALICE, 'Alice-Role', 'Alice works in technical partnerships', {
      importance: 8,
    })
    await store.semanticSave(BOB, 'Bob-Role', 'Bob works in finance operations', { importance: 8 })
    await store.episodicSave(ALICE, 'meeting', 'Acme flagged EU data residency as a blocker', {
      importance: 7,
    })
    await store.proceduralSave(ALICE, 'Brief Prep', 'Always list unresolved action items first')

    // Relevance: each user's own fact ranks for their own scoped query.
    const aliceHits = await searchWithRetry(
      () => store.semanticSearch(ALICE, 'what is my job role', 10),
      (r) => r.some((d) => /technical partnerships/i.test(d.description))
    )
    const bobHits = await searchWithRetry(
      () => store.semanticSearch(BOB, 'what is my job role', 10),
      (r) => r.some((d) => /finance operations/i.test(d.description))
    )
    expect(aliceHits.some((d) => /technical partnerships/i.test(d.description))).toBe(true)
    expect(bobHits.some((d) => /finance operations/i.test(d.description))).toBe(true)

    // Isolation: every returned doc belongs to the querying scope …
    expect(aliceHits.every((d) => d.user_id === ALICE)).toBe(true)
    expect(bobHits.every((d) => d.user_id === BOB)).toBe(true)
    // … and neither user can see the other's fact.
    expect(aliceHits.some((d) => /finance operations/i.test(d.description))).toBe(false)
    expect(bobHits.some((d) => /technical partnerships/i.test(d.description))).toBe(false)

    // Episodic + procedural are scope-partitioned too: Bob gets nothing of Alice's.
    const bobEpisodic = await store.episodicSearch(BOB, 'EU data residency', 10)
    const bobProcedural = await store.proceduralSearch(BOB, 'action items', 10)
    expect(bobEpisodic.some((d) => /data residency/i.test(d.description))).toBe(false)
    expect(bobProcedural.some((d) => /action items/i.test(d.description))).toBe(false)
    expect(bobEpisodic.every((d) => d.user_id === BOB)).toBe(true)
    expect(bobProcedural.every((d) => d.user_id === BOB)).toBe(true)

    // And Alice DOES get her own episodic/procedural docs back (relevance).
    const aliceEpisodic = await searchWithRetry(
      () => store.episodicSearch(ALICE, 'EU data residency', 10),
      (r) => r.some((d) => /data residency/i.test(d.description))
    )
    const aliceProcedural = await searchWithRetry(
      () => store.proceduralSearch(ALICE, 'action items', 10),
      (r) => r.some((d) => /action items/i.test(d.description))
    )
    expect(aliceEpisodic.some((d) => /data residency/i.test(d.description))).toBe(true)
    expect(aliceProcedural.some((d) => /action items/i.test(d.description))).toBe(true)
  }, 120_000)

  // ── 4. AI SDK memory tool (buildMemoryTool) works in auto-embed mode ─────────
  it('memory tool save+search round-trips in auto-embed mode', async () => {
    const memoryTool = buildMemoryTool(store, USER, 'sess-autoembed', undefined, config)

    // Save via the tool executor (the same code path the agent loop drives).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const saveOut: any = await (memoryTool.execute as any)({
      command: 'semantic_save',
      name: 'Jordan',
      content: 'Enjoys mountain biking on weekends',
      importance: 7,
    })
    expect(saveOut.output).toMatch(/saved/i)

    // The tool wrote embed_text (no client embedding).
    const doc = (await client
      .db(AUTO_DB)
      .collection('semantic_memory')
      .findOne({ user_id: USER, name: 'Jordan', is_latest: true })) as Record<
      string,
      unknown
    > | null
    expect(doc).not.toBeNull()
    expect(typeof doc!.embed_text).toBe('string')
    expect(doc!.embedding).toBeUndefined()

    if (!voyageReady) {
      console.warn('[test] Search half skipped — autoEmbed indexes not READY (Voyage AI not enabled?).')
      return
    }

    // Search via the tool executor and confirm the saved doc is surfaced.
    const found = await searchWithRetry(
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const out: any = await (memoryTool.execute as any)({
          command: 'semantic_search',
          query: 'weekend cycling hobby',
        })
        return [out.output as string]
      },
      (outs) => outs.some((o) => o.includes('Jordan')),
      8,
      3_000
    )
    expect(found.some((o) => o.includes('Jordan'))).toBe(true)
  }, 60_000)
})
