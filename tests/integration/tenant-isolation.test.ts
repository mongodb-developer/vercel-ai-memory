import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { MongoClient } from 'mongodb'
import { MongoMemoryStore } from '../../src/store'
import { EmbeddingAdapter } from '../../src/embeddings'
import { resolveConfig } from '../../src/config'
import { mockEmbedder } from '../helpers/mock-embedder'
import { ATLAS_URI } from '../helpers/atlas-client'

/**
 * #16 — tenant isolation via `extraFilterFields` + `scope` against real Atlas.
 *
 * Two tenants share the same `userId` ("alice"). With `tenant_id` bound via
 * `withScope`, neither tenant can read, search, forget, or promote the other's
 * memories, and every document is written with its tenant.
 *
 * Uses its own database so the tenant-aware vector indexes don't collide with
 * the shared test database's indexes.
 */
const DB = 'agent_memory_tenant_test'
const USER = 'alice'

let client: MongoClient
let root: MongoMemoryStore
let acme: MongoMemoryStore
let globex: MongoMemoryStore

async function waitForIndexes(timeoutMs = 120_000): Promise<void> {
  const db = client.db(DB)
  const pairs = [
    ['semantic_memory', 'semantic_vector_index'],
    ['procedural_memory', 'procedural_vector_index'],
    ['episodic_memory', 'episodic_vector_index'],
  ]
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    let ready = true
    for (const [col, name] of pairs) {
      const idx = await db.collection(col).listSearchIndexes(name).toArray()
      if (idx[0]?.status !== 'READY' || idx[0]?.queryable === false) ready = false
    }
    if (ready) return
    await new Promise((r) => setTimeout(r, 3_000))
  }
}

/** Retry a search until it returns results (vector index sync is async). */
async function eventually<T>(fn: () => Promise<T[]>, timeoutMs = 30_000): Promise<T[]> {
  const deadline = Date.now() + timeoutMs
  let last: T[] = []
  while (Date.now() < deadline) {
    last = await fn()
    if (last.length > 0) return last
    await new Promise((r) => setTimeout(r, 1_000))
  }
  return last
}

beforeAll(async () => {
  client = new MongoClient(ATLAS_URI!, { appName: 'devrel-integration-memory-vercel-typescript' })
  await client.connect()
  for (const c of ['session_memory', 'semantic_memory', 'procedural_memory', 'episodic_memory', 'scratchpad_memory']) {
    await client.db(DB).collection(c).drop().catch(() => {})
  }
  const config = resolveConfig({
    uri: ATLAS_URI!,
    embedder: mockEmbedder,
    topology: {
      dbName: DB,
      extraFilterFields: {
        semantic: ['tenant_id'],
        procedural: ['tenant_id'],
        episodic: ['tenant_id'],
      },
    },
  })
  root = new MongoMemoryStore(client, new EmbeddingAdapter(mockEmbedder), config)
  await root.bootstrap()
  await waitForIndexes()
  acme = root.withScope({ tenant_id: 'acme' })
  globex = root.withScope({ tenant_id: 'globex' })
}, 180_000)

afterAll(async () => {
  await client?.db(DB).dropDatabase().catch(() => {})
  await client?.close()
})

describe('Tenant isolation (extraFilterFields + scope)', () => {
  it('writes tenant_id on every saved document', async () => {
    await acme.semanticSave(USER, 'plan', 'acme enterprise plan')
    const doc = await client.db(DB).collection('semantic_memory').findOne({ name: 'plan' })
    expect(doc?.tenant_id).toBe('acme')
  })

  it('same userId + same name in two tenants are separate documents', async () => {
    await acme.semanticSave(USER, 'diet', 'acme alice is vegetarian')
    await globex.semanticSave(USER, 'diet', 'globex alice is vegan')
    const docs = await client.db(DB).collection('semantic_memory').find({ name: 'diet' }).toArray()
    expect(docs.map((d) => d.tenant_id).sort()).toEqual(['acme', 'globex'])
  })

  it('vector search never returns the other tenant\'s memories', async () => {
    await acme.episodicSave(USER, 'meeting', 'acme quarterly review with alice')
    await globex.episodicSave(USER, 'meeting', 'globex quarterly review with alice')

    const a = await eventually(() => acme.episodicSearch(USER, 'quarterly review', 10))
    const g = await eventually(() => globex.episodicSearch(USER, 'quarterly review', 10))

    expect(a.length).toBeGreaterThan(0)
    expect(g.length).toBeGreaterThan(0)
    expect(a.every((d) => (d as unknown as { tenant_id: string }).tenant_id === 'acme')).toBe(true)
    expect(g.every((d) => (d as unknown as { tenant_id: string }).tenant_id === 'globex')).toBe(true)
  })

  it('session and scratchpad reads are tenant-scoped even with the same session id', async () => {
    const sess = `tenant-sess-${Date.now()}`
    await acme.sessionAppend(USER, sess, 'user', 'acme secret')
    await acme.scratchpadWrite(USER, sess, 'acme note')

    expect(await globex.sessionRecent(USER, sess)).toHaveLength(0)
    expect(await globex.scratchpadRead(USER, sess)).toHaveLength(0)
    expect(await acme.sessionRecent(USER, sess)).toHaveLength(1)
  })

  it('another tenant cannot forget or promote by id', async () => {
    const sess = `tenant-promote-${Date.now()}`
    const epId = await acme.episodicSave(USER, 'deal', 'acme closed a deal')
    const noteId = await acme.scratchpadWrite(USER, sess, 'acme draft')

    await expect(globex.forget(USER, 'episodic', epId.toString())).resolves.toBe(false)
    await expect(
      globex.scratchpadPromote(noteId.toString(), USER, 'interaction')
    ).rejects.toThrow(/not found/)

    const ep = await client.db(DB).collection('episodic_memory').findOne({ _id: epId })
    expect(ep?.expire_at ?? null).toBeNull()
    await expect(acme.forget(USER, 'episodic', epId.toString())).resolves.toBe(true)
  })
})
