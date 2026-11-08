import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { MongoClient } from 'mongodb'
import { ATLAS_URI } from '../../helpers/atlas-client'

/**
 * Eve adapter — FULL integration over live Atlas in Atlas Automated Embedding
 * mode (the shipping configuration for v0.5.0).
 *
 * Unlike tests/integration/eve/scope.test.ts (which drives the *store* directly
 * with a mock embedder), this exercises the REAL provider surface produced by
 * `mongodbMemory({ autoEmbed })`, exactly as Eve would call it, against the
 * contract in https://eve.dev/docs/memory/custom-provider :
 *
 *   - recall["turn.started"](ctx)      → { messages: [{ id, content }] }
 *   - capture["turn.completed"](ctx)   → writes, idempotent on ctx.operationId
 *   - tools(ctx).remember / .forget    → bound to the LOCKED scope, model never
 *                                        supplies the owner
 *
 * and asserts, with REAL Voyage rankings:
 *   #4 durability across a brand-new provider instance ("new Eve session")
 *   #5/#6 recall is partitioned by memory.scope.key (no cross-principal leak)
 *   #7/#8 remember / forget tools
 *   #9 automatic capture (heuristic path, no LLM key needed)
 *   #10 capture replay with the same operationId does NOT duplicate episodic events
 *   docs are persisted with `embed_text` and NO client `embedding` array
 *
 * `eve` is an optional peer dep and is not installed here, so we mock ONLY the
 * tiny Eve SDK surface the adapter imports (pass-through stubs — same approach
 * as tests/unit/eve). MongoDB, the store, Atlas indexes and $vectorSearch are
 * all real.
 *
 * Gating: skipped without MONGODB_URI. If autoEmbed indexes never reach READY
 * (Voyage AI not enabled for the org), the ranking assertions are skipped with
 * a clear reason; persistence + tool + idempotency assertions still run.
 */

vi.mock('eve/memory', () => ({
  defineMemoryProvider: (def: unknown) => def,
  defineMemory: (def: unknown) => def,
}))
vi.mock('eve/tools', () => ({
  defineTool: (def: unknown) => def,
  disableTool: () => ({ disabled: true }),
}))
vi.mock('eve/memory/scope', () => ({
  byPrincipal: () => 'principal-key',
}))

// Import AFTER mocks are registered.
import { mongodbMemory } from '../../../src/eve'

const AUTO_DB = 'agent_memory_eve_autoembed_test'
const AUTO_MODEL = 'voyage-4'
const VECTOR_COLLECTIONS = ['semantic_memory', 'procedural_memory', 'episodic_memory'] as const
const VECTOR_INDEXES = [
  'semantic_vector_index',
  'procedural_vector_index',
  'episodic_vector_index',
] as const

// Eve scope keys are opaque digests; distinct principals → distinct keys.
const ALICE = 'eve-ae-scope-alice'
const BOB = 'eve-ae-scope-bob'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Provider = {
  recall: { 'turn.started': (ctx: any) => Promise<{ messages: Array<{ id?: string; content: string }> }> }
  capture?: { 'turn.completed': (ctx: any) => Promise<void> }
  tools: (ctx: any) => Record<string, { execute: (input: any) => Promise<any> }>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Build a MemoryOperationContext the way Eve does for `turn.started`. */
function recallCtx(scopeKey: string, userText: string, opId = `op-${scopeKey}-${Date.now()}`) {
  return {
    memory: { scope: { key: scopeKey, namespace: 'memory/profile', value: scopeKey }, slot: 'profile' },
    turn: { id: 't1', sequence: 0, input: [{ role: 'user', content: userText }] },
    messages: [],
    operationId: opId,
  }
}

/** Build a MemoryOperationContext the way Eve does for `turn.completed`. */
function captureCtx(
  scopeKey: string,
  messages: Array<{ role: string; content: string }>,
  opId: string
) {
  return {
    memory: { scope: { key: scopeKey, namespace: 'memory/profile', value: scopeKey }, slot: 'profile' },
    turn: { id: 't1', sequence: 0, input: messages.filter((m) => m.role === 'user') },
    messages,
    operationId: opId,
  }
}

function makeProvider(): Provider {
  return mongodbMemory({
    uri: ATLAS_URI!,
    dbName: AUTO_DB,
    autoEmbed: { model: AUTO_MODEL },
    // "automatic" with NO captureModel → heuristic path (no LLM key needed).
    capture: 'automatic',
  }) as unknown as Provider
}

let client: MongoClient
let provider: Provider
let voyageReady = false

async function waitForIndexReady(collection: string, indexName: string, timeoutMs = 120_000) {
  const db = client.db(AUTO_DB)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const idx = (await db.collection(collection).listSearchIndexes(indexName).toArray()).find(
        (i: { name: string }) => i.name === indexName
      ) as { status?: string } | undefined
      if (idx?.status === 'READY') return true
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 3_000))
  }
  return false
}

async function retry<T>(fn: () => Promise<T>, ok: (v: T) => boolean, attempts = 8, delayMs = 3_000) {
  let last!: T
  for (let i = 0; i < attempts; i++) {
    last = await fn()
    if (ok(last)) return last
    await new Promise((r) => setTimeout(r, delayMs))
  }
  return last
}

const suite = ATLAS_URI ? describe : describe.skip

suite('Eve provider — full integration over Atlas Automated Embedding', () => {
  beforeAll(async () => {
    client = new MongoClient(ATLAS_URI!, { appName: 'eve-autoembed-integration' })
    await client.connect()

    // Clear DATA but keep collections (and their autoEmbed indexes) so re-runs
    // don't pay the ~40s+ index rebuild. A wrong-type index makes bootstrap throw.
    const db = client.db(AUTO_DB)
    for (const name of VECTOR_COLLECTIONS) {
      await db.collection(name).deleteMany({}).catch(() => {})
    }

    // The REAL provider. Its first handler call lazily connects + bootstraps.
    provider = makeProvider()
    // Force bootstrap now via an empty-query recall (returns [] without searching).
    await provider.recall['turn.started'](recallCtx(ALICE, '   '))

    const ready = await Promise.all(
      VECTOR_COLLECTIONS.map((c, i) => waitForIndexReady(c, VECTOR_INDEXES[i]))
    )
    voyageReady = ready.every(Boolean)
    if (!voyageReady) {
      console.warn(
        '\n[test] ⚠️  Eve autoEmbed indexes did not reach READY — Voyage AI is probably\n' +
          '[test]     not enabled for this org. Ranking assertions will be skipped.\n'
      )
    } else {
      console.log('[test] ✅ Eve autoEmbed indexes READY on db:', AUTO_DB)
    }
  }, 180_000)

  afterAll(async () => {
    if (client) {
      const db = client.db(AUTO_DB)
      for (const name of VECTOR_COLLECTIONS) {
        await db.collection(name).deleteMany({}).catch(() => {})
      }
      await client.close()
    }
  })

  // ── Provider shape matches the Eve contract ─────────────────────────────────
  it('exposes recall["turn.started"], capture["turn.completed"], and tools()', () => {
    expect(typeof provider.recall['turn.started']).toBe('function')
    expect(typeof provider.capture?.['turn.completed']).toBe('function')
    expect(typeof provider.tools).toBe('function')
    const toolset = provider.tools(recallCtx(ALICE, 'x'))
    // Keys must be valid `<slot>__<key>` suffixes: letters/digits/_/- only.
    for (const key of Object.keys(toolset)) expect(key).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/)
    expect(toolset).toHaveProperty('remember')
    expect(toolset).toHaveProperty('forget')
  })

  // ── Index shape: autoEmbed / voyage-4 / embed_text ──────────────────────────
  it('bootstraps type:"autoEmbed" indexes (model voyage-4, path embed_text)', async () => {
    if (!voyageReady) return console.warn('[test] Skipped — indexes not READY.')
    const db = client.db(AUTO_DB)
    for (let i = 0; i < VECTOR_COLLECTIONS.length; i++) {
      const idx = (
        await db.collection(VECTOR_COLLECTIONS[i]).listSearchIndexes(VECTOR_INDEXES[i]).toArray()
      ).find((x: { name: string }) => x.name === VECTOR_INDEXES[i]) as Record<string, unknown>
      const def = (idx.latestDefinition ?? idx.definition) as {
        fields?: Array<{ type?: string; path?: string; model?: string }>
      }
      const vf = def.fields?.find((f) => f.type === 'autoEmbed')
      expect(vf?.path).toBe('embed_text')
      expect(vf?.model).toBe(AUTO_MODEL)
    }
  })

  // ── #7 remember tool: writes under the LOCKED scope, persists embed_text ────
  it('remember tool writes under the locked scope with embed_text (no embedding)', async () => {
    const tools = provider.tools(recallCtx(ALICE, 'x'))
    const out = await tools.remember.execute({
      content: 'Alice works in technical partnerships',
      type: 'semantic',
      label: 'Alice-Role',
      importance: 8,
    })
    expect(out).toMatchObject({ saved: true, type: 'semantic', label: 'Alice-Role' })

    const doc = (await client
      .db(AUTO_DB)
      .collection('semantic_memory')
      .findOne({ name: 'Alice-Role', is_latest: true })) as Record<string, unknown> | null
    expect(doc).not.toBeNull()
    expect(doc!.user_id).toBe(ALICE) // scope came from ctx, not model input
    expect(typeof doc!.embed_text).toBe('string')
    expect(doc!.embedding).toBeUndefined()
  })

  it('remember routes episodic + procedural under the same locked scope', async () => {
    const tools = provider.tools(recallCtx(ALICE, 'x'))
    await tools.remember.execute({
      content: 'Acme flagged EU data residency as a blocker',
      type: 'episodic',
      label: 'meeting',
      importance: 7,
    })
    await tools.remember.execute({
      content: 'Always list unresolved action items first',
      type: 'procedural',
      label: 'Brief Prep',
    })
    const db = client.db(AUTO_DB)
    const ep = (await db.collection('episodic_memory').findOne({ event_type: 'meeting' })) as Record<string, unknown>
    const pr = (await db.collection('procedural_memory').findOne({ task: 'Brief Prep' })) as Record<string, unknown>
    expect(ep.user_id).toBe(ALICE)
    expect(pr.user_id).toBe(ALICE)
    expect(typeof ep.embed_text).toBe('string')
    expect(typeof pr.embed_text).toBe('string')
    expect(ep.embedding).toBeUndefined()
    expect(pr.embedding).toBeUndefined()
  })


  // ── #5/#6 recall["turn.started"]: real Voyage ranking, partitioned by scope ─
  it('recall returns Eve-shaped messages with the right fact for the scope', async () => {
    if (!voyageReady) return console.warn('[test] Skipped — indexes not READY.')
    // Bob gets his own fact so cross-scope leakage is detectable.
    await provider.tools(recallCtx(BOB, 'x')).remember.execute({
      content: 'Bob works in finance operations',
      type: 'semantic',
      label: 'Bob-Role',
      importance: 8,
    })

    const res = await retry(
      () => provider.recall['turn.started'](recallCtx(ALICE, 'what is my job role?')),
      (r) => r.messages.some((m) => /technical partnerships/i.test(m.content))
    )
    // Eve contract: { messages: [{ id, content }] }, id stable & ≤ 1024 bytes.
    expect(Array.isArray(res.messages)).toBe(true)
    expect(res.messages.some((m) => /technical partnerships/i.test(m.content))).toBe(true)
    for (const m of res.messages) {
      expect(typeof m.content).toBe('string')
      expect(typeof m.id).toBe('string')
      expect(Buffer.byteLength(m.id!, 'utf8')).toBeLessThanOrEqual(1024)
    }
    // Recall content is prefixed by tier so it's attributable in model context.
    expect(res.messages.some((m) => m.content.startsWith('Known fact — '))).toBe(true)

    // Isolation: Alice must NEVER see Bob's fact, and vice-versa.
    expect(res.messages.some((m) => /finance operations/i.test(m.content))).toBe(false)
    const bob = await retry(
      () => provider.recall['turn.started'](recallCtx(BOB, 'what is my job role?')),
      (r) => r.messages.some((m) => /finance operations/i.test(m.content))
    )
    expect(bob.messages.some((m) => /finance operations/i.test(m.content))).toBe(true)
    expect(bob.messages.some((m) => /technical partnerships/i.test(m.content))).toBe(false)
  }, 120_000)

  it('recall surfaces episodic + procedural tiers too, still scope-partitioned', async () => {
    if (!voyageReady) return console.warn('[test] Skipped — indexes not READY.')
    const alice = await retry(
      () => provider.recall['turn.started'](recallCtx(ALICE, 'EU data residency and action items')),
      (r) =>
        r.messages.some((m) => /data residency/i.test(m.content)) &&
        r.messages.some((m) => /action items/i.test(m.content))
    )
    expect(alice.messages.some((m) => m.content.startsWith('Past event [meeting]'))).toBe(true)
    expect(alice.messages.some((m) => m.content.startsWith('Procedure — Brief Prep'))).toBe(true)

    const bob = await provider.recall['turn.started'](recallCtx(BOB, 'EU data residency and action items'))
    expect(bob.messages.some((m) => /data residency/i.test(m.content))).toBe(false)
    expect(bob.messages.some((m) => /action items/i.test(m.content))).toBe(false)
  }, 120_000)

  // ── recall id is STABLE for replaceable facts (supersede semantics) ─────────
  it('same fact re-remembered keeps the same recall id (supersede, not accumulate)', async () => {
    if (!voyageReady) return console.warn('[test] Skipped — indexes not READY.')
    const first = await retry(
      () => provider.recall['turn.started'](recallCtx(ALICE, 'what is my job role?')),
      (r) => r.messages.some((m) => /technical partnerships/i.test(m.content))
    )
    const idBefore = first.messages.find((m) => /technical partnerships/i.test(m.content))!.id

    // Update the same labelled fact → semantic upsert keeps the _id.
    await provider.tools(recallCtx(ALICE, 'x')).remember.execute({
      content: 'Alice leads technical partnerships for EMEA',
      type: 'semantic',
      label: 'Alice-Role',
    })
    const after = await retry(
      () => provider.recall['turn.started'](recallCtx(ALICE, 'what is my job role?')),
      (r) => r.messages.some((m) => /EMEA/i.test(m.content))
    )
    const updated = after.messages.find((m) => /EMEA/i.test(m.content))!
    expect(updated.id).toBe(idBefore)
    // Only ONE Alice-Role doc exists (no accumulation).
    const n = await client
      .db(AUTO_DB)
      .collection('semantic_memory')
      .countDocuments({ user_id: ALICE, name: 'Alice-Role' })
    expect(n).toBe(1)
  }, 120_000)

  // ── #4 durability across a brand-new provider instance ("new Eve session") ──
  it('a fresh provider instance recalls memories written by the previous one', async () => {
    if (!voyageReady) return console.warn('[test] Skipped — indexes not READY.')
    const fresh = makeProvider()
    const res = await retry(
      () => fresh.recall['turn.started'](recallCtx(ALICE, 'what is my job role?')),
      (r) => r.messages.some((m) => /technical partnerships/i.test(m.content))
    )
    expect(res.messages.some((m) => /technical partnerships/i.test(m.content))).toBe(true)
  }, 120_000)


  // ── #9 automatic capture (heuristic path) + #10 idempotent replay ───────────
  it('capture["turn.completed"] persists under the scope and is idempotent on operationId', async () => {
    const opId = `op-capture-${Date.now()}`
    const msgs = [
      { role: 'user', content: 'Please remember: I prefer concise, bullet-point briefs.' },
      { role: 'assistant', content: 'Noted.' },
    ]
    const col = client.db(AUTO_DB).collection('semantic_memory')

    await provider.capture!['turn.completed'](captureCtx(ALICE, msgs, opId))
    const doc = (await col.findOne({ user_id: ALICE, name: 'User statement' })) as Record<string, unknown> | null
    expect(doc).not.toBeNull()
    expect(doc!.description).toMatch(/concise, bullet-point briefs/)
    expect(typeof doc!.embed_text).toBe('string')
    expect(doc!.embedding).toBeUndefined()

    // Eve may replay the same operationId — must not create a second doc.
    await provider.capture!['turn.completed'](captureCtx(ALICE, msgs, opId))
    expect(await col.countDocuments({ user_id: ALICE, name: 'User statement' })).toBe(1)

    // Bob's capture never lands under Alice.
    await provider.capture!['turn.completed'](
      captureCtx(BOB, [{ role: 'user', content: 'I prefer long-form narrative briefs.' }], `${opId}-bob`)
    )
    expect(await col.countDocuments({ user_id: ALICE, name: 'User statement' })).toBe(1)
    const bobDoc = (await col.findOne({ user_id: BOB, name: 'User statement' })) as Record<string, unknown>
    expect(bobDoc.description).toMatch(/long-form/)
  })

  it('episodic capture replay with the same operationId does not duplicate the event', async () => {
    const { persistExtracted } = await import('../../../src/eve/capture')
    const { MongoMemoryStore } = await import('../../../src/store')
    const { EmbeddingAdapter } = await import('../../../src/embeddings')
    const { resolveConfig } = await import('../../../src/config')
    const store = new MongoMemoryStore(
      client,
      new EmbeddingAdapter(null),
      resolveConfig({ uri: ATLAS_URI!, dbName: AUTO_DB, autoEmbed: { model: AUTO_MODEL } })
    )
    const opId = `op-episodic-${Date.now()}`
    const mem = { type: 'episodic' as const, label: 'deal', content: 'Closed the Acme renewal' }
    const col = client.db(AUTO_DB).collection('episodic_memory')
    const count = () =>
      col.countDocuments({ user_id: ALICE, event_type: 'deal', description: mem.content })

    await persistExtracted(store, ALICE, mem, opId)
    await persistExtracted(store, ALICE, mem, opId) // replay → no-op
    expect(await count()).toBe(1)

    // A genuinely new operation for the same event text IS a new event.
    await persistExtracted(store, ALICE, mem, `${opId}-2`)
    expect(await count()).toBe(2)
  })

  // ── #8 forget tool ─────────────────────────────────────────────────────────
  it('forget tool marks the doc for deletion by id + tier', async () => {
    const col = client.db(AUTO_DB).collection('semantic_memory')
    const doc = (await col.findOne({ user_id: BOB, name: 'Bob-Role' })) as Record<string, unknown> | null
    // Bob-Role is written by the recall test; if ranking tests were skipped, seed it.
    if (!doc) {
      await provider.tools(recallCtx(BOB, 'x')).remember.execute({
        content: 'Bob works in finance operations',
        type: 'semantic',
        label: 'Bob-Role',
      })
    }
    const target = (await col.findOne({ user_id: BOB, name: 'Bob-Role' })) as Record<string, unknown>
    expect(target).toBeTruthy()

    const out = await provider.tools(recallCtx(BOB, 'x')).forget.execute({
      id: String(target._id),
      type: 'semantic',
    })
    expect(out).toMatchObject({ forgotten: true, type: 'semantic' })

    const after = (await col.findOne({ _id: target._id as never })) as Record<string, unknown>
    expect(after.expire_at).toBeInstanceOf(Date)
    expect((after.expire_at as Date).getTime()).toBeLessThanOrEqual(Date.now())
  })
})

