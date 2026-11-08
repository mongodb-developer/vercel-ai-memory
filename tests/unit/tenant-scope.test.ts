import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObjectId } from 'mongodb'
import type { MongoClient } from 'mongodb'
import { MongoMemoryStore } from '../../src/store'
import { EmbeddingAdapter } from '../../src/embeddings'
import { resolveConfig } from '../../src/config'
import { createOnFinish, loadSession } from '../../src/session-hooks'
import { mockEmbedder } from '../helpers/mock-embedder'
import type { MongoDBMemoryOptions } from '../../src/types'

/**
 * #16 — `topology.extraFilterFields` (e.g. `tenant_id`) must be written on
 * every save and enforced on every read / search / forget / promote when a
 * trusted `scope` is bound. Without a scope, behavior is unchanged.
 *
 * No network: the MongoClient is a stub that records each call.
 */

type Col = Record<
  | 'find'
  | 'findOne'
  | 'findOneAndUpdate'
  | 'updateOne'
  | 'updateMany'
  | 'insertOne'
  | 'insertMany'
  | 'aggregate',
  ReturnType<typeof vi.fn>
>

function makeCol(): Col {
  return {
    find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    findOne: vi.fn().mockResolvedValue(null),
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
    updateOne: vi.fn().mockResolvedValue({ matchedCount: 1 }),
    updateMany: vi.fn().mockResolvedValue({ matchedCount: 0 }),
    insertOne: vi.fn().mockResolvedValue({ insertedId: new ObjectId() }),
    insertMany: vi.fn().mockResolvedValue({}),
    aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
  }
}

const ID = '507f1f77bcf86cd799439011'
const ACME = { tenant_id: 'acme' }

let cols: Record<string, Col>

function makeStore(topology: MongoDBMemoryOptions['topology'] = {}): MongoMemoryStore {
  cols = {}
  const db = {
    collection: (name: string) => (cols[name] ??= makeCol()),
    command: vi.fn(),
  }
  const client = { db: () => db } as unknown as MongoClient
  const config = resolveConfig({
    uri: 'mongodb://stub',
    embedder: mockEmbedder,
    topology: {
      extraFilterFields: {
        semantic: ['tenant_id'],
        procedural: ['tenant_id'],
        episodic: ['tenant_id'],
      },
      ...topology,
    },
  })
  return new MongoMemoryStore(client, new EmbeddingAdapter(mockEmbedder), config)
}

/** The `filter` of the `$vectorSearch` stage of the n-th aggregate call. */
function vectorFilter(col: Col, n = 0): Record<string, unknown> {
  return col.aggregate.mock.calls[n][0][0].$vectorSearch.filter
}

let store: MongoMemoryStore
let acme: MongoMemoryStore

beforeEach(() => {
  store = makeStore()
  acme = store.withScope(ACME)
})

describe('withScope', () => {
  it('returns a view bound to the scope; the root store stays unscoped', () => {
    expect(acme).not.toBe(store)
    expect(acme.scope).toEqual(ACME)
    expect(store.scope).toEqual({})
  })

  it('returns the same store when no scope is given', () => {
    expect(store.withScope(undefined)).toBe(store)
    expect(store.withScope({})).toBe(store)
  })

  it('rejects scope keys that are not declared in extraFilterFields', () => {
    expect(() => store.withScope({ org_id: 'x' })).toThrow(/not declared/)
  })

  it.each([
    ['empty string', ''],
    ['whitespace', '   '],
    ['operator object', { $ne: null }],
    ['number', 42],
  ])('rejects a %s value (fail closed)', (_label, value) => {
    expect(() => store.withScope({ tenant_id: value as never })).toThrow(/non-empty string/)
  })

  it('rejects a non-object scope', () => {
    expect(() => store.withScope('acme' as never)).toThrow(/must be an object/)
  })
})

describe('writes carry the scope fields', () => {
  it('sessionAppend', async () => {
    await acme.sessionAppend('alice', 's1', 'user', 'hi')
    expect(cols.session_memory.insertMany.mock.calls[0][0][0]).toMatchObject({
      user_id: 'alice',
      tenant_id: 'acme',
    })
  })

  it('semanticSave (upsert): filter and $setOnInsert', async () => {
    await acme.semanticSave('alice', 'diet', 'vegetarian')
    const [filter, update] = cols.semantic_memory.updateOne.mock.calls[0]
    expect(filter).toEqual({ tenant_id: 'acme', user_id: 'alice', name: 'diet' })
    expect(update.$setOnInsert).toMatchObject({ tenant_id: 'acme', user_id: 'alice' })
  })

  it('semanticSave (keepHistory): version flip filter and inserted doc', async () => {
    const hist = makeStore({ keepHistory: true }).withScope(ACME)
    await hist.semanticSave('alice', 'diet', 'vegetarian')
    expect(cols.semantic_memory.updateMany.mock.calls[0][0]).toEqual({
      tenant_id: 'acme',
      user_id: 'alice',
      name: 'diet',
    })
    expect(cols.semantic_memory.insertOne.mock.calls[0][0]).toMatchObject({
      tenant_id: 'acme',
      user_id: 'alice',
    })
  })

  it('proceduralSave (upsert): filter and $setOnInsert', async () => {
    await acme.proceduralSave('alice', 'checkout', 'steps')
    const [filter, update] = cols.procedural_memory.updateOne.mock.calls[0]
    expect(filter).toEqual({ tenant_id: 'acme', user_id: 'alice', task: 'checkout' })
    expect(update.$setOnInsert).toMatchObject({ tenant_id: 'acme', user_id: 'alice' })
  })

  it('episodicSave', async () => {
    await acme.episodicSave('alice', 'meeting', 'met acme')
    expect(cols.episodic_memory.insertOne.mock.calls[0][0]).toMatchObject({
      tenant_id: 'acme',
      user_id: 'alice',
    })
  })

  it('scratchpadWrite', async () => {
    await acme.scratchpadWrite('alice', 's1', 'note')
    expect(cols.scratchpad_memory.insertOne.mock.calls[0][0]).toMatchObject({
      tenant_id: 'acme',
      user_id: 'alice',
    })
  })
})

describe('reads, searches, forget, and promote enforce the scope', () => {
  it.each(['semantic', 'procedural', 'episodic'] as const)(
    '%s search puts tenant_id in the $vectorSearch filter',
    async (type) => {
      const search = {
        semantic: () => acme.semanticSearch('alice', 'q'),
        procedural: () => acme.proceduralSearch('alice', 'q'),
        episodic: () => acme.episodicSearch('alice', 'q'),
      }[type]
      await search()
      expect(vectorFilter(cols[`${type}_memory`])).toMatchObject({
        tenant_id: { $eq: 'acme' },
        user_id: { $eq: 'alice' },
      })
    }
  )

  it('applies a scope field not indexed for a type as a $match after $vectorSearch', async () => {
    const partial = makeStore({
      extraFilterFields: { semantic: ['tenant_id'] },
    }).withScope(ACME)
    await partial.episodicSearch('alice', 'q')
    const pipeline = cols.episodic_memory.aggregate.mock.calls[0][0]
    expect(pipeline[0].$vectorSearch.filter).toEqual({ user_id: { $eq: 'alice' } })
    expect(pipeline[1]).toEqual({ $match: { tenant_id: 'acme' } })
  })

  it('sessionRecent', async () => {
    await acme.sessionRecent('alice', 's1')
    expect(cols.session_memory.find.mock.calls[0][0]).toEqual({
      tenant_id: 'acme',
      user_id: 'alice',
      session_id: 's1',
    })
  })

  it('scratchpadRead', async () => {
    await acme.scratchpadRead('alice', 's1')
    expect(cols.scratchpad_memory.find.mock.calls[0][0]).toEqual({
      tenant_id: 'acme',
      user_id: 'alice',
      session_id: 's1',
      promoted: false,
    })
  })


  it('scratchpadPromote claims only a note in the same tenant and writes the episode there', async () => {
    const noteId = new ObjectId(ID)
    cols.scratchpad_memory.findOneAndUpdate.mockResolvedValue({ _id: noteId, note: 'n' })
    await acme.scratchpadPromote(ID, 'alice', 'interaction')
    expect(cols.scratchpad_memory.findOneAndUpdate.mock.calls[0][0]).toEqual({
      _id: noteId,
      tenant_id: 'acme',
      user_id: 'alice',
      promoted: false,
    })
    expect(cols.episodic_memory.insertOne.mock.calls[0][0]).toMatchObject({
      tenant_id: 'acme',
      user_id: 'alice',
    })
    expect(cols.scratchpad_memory.updateOne.mock.calls[0][0]).toEqual({
      _id: noteId,
      tenant_id: 'acme',
      user_id: 'alice',
    })
  })

  it.each(['session', 'semantic', 'procedural', 'episodic', 'scratchpad'] as const)(
    'forget (%s) filters by tenant_id',
    async (type) => {
      await acme.forget('alice', type, ID)
      expect(cols[`${type}_memory`].updateOne.mock.calls[0][0]).toEqual({
        _id: new ObjectId(ID),
        tenant_id: 'acme',
        user_id: 'alice',
      })
    }
  )

  it('episodicExists: a caller filter cannot override the tenant scope', async () => {
    await acme.episodicExists('alice', { tenant_id: 'globex', event_type: 'login' })
    expect(cols.episodic_memory.findOne.mock.calls[0][0]).toEqual({
      event_type: 'login',
      tenant_id: 'acme',
      user_id: 'alice',
    })
  })
})

describe('opt-in: no scope means pre-1.0.1 behavior', () => {
  it('unscoped store writes and filters on user_id only', async () => {
    await store.semanticSave('alice', 'diet', 'vegetarian')
    await store.semanticSearch('alice', 'q')
    expect(cols.semantic_memory.updateOne.mock.calls[0][0]).toEqual({
      user_id: 'alice',
      name: 'diet',
    })
    expect(vectorFilter(cols.semantic_memory)).toEqual({
      user_id: { $eq: 'alice' },
      is_latest: { $eq: true },
    })
  })
})

describe('requireScope: true fails closed', () => {
  it('throws on every operation when the scope is missing', async () => {
    const strict = makeStore({ requireScope: true })
    await expect(strict.semanticSave('alice', 'n', 'd')).rejects.toThrow(/requireScope/)
    await expect(strict.episodicSearch('alice', 'q')).rejects.toThrow(/requireScope/)
    await expect(strict.sessionRecent('alice', 's1')).rejects.toThrow(/requireScope/)
    await expect(strict.forget('alice', 'semantic', ID)).rejects.toThrow(/requireScope/)
    expect(cols.semantic_memory?.updateOne ?? vi.fn()).not.toHaveBeenCalled()
  })

  it('works when the scope is bound', async () => {
    const strict = makeStore({ requireScope: true }).withScope(ACME)
    await expect(strict.semanticSave('alice', 'n', 'd')).resolves.toBeUndefined()
  })
})

describe('session hooks pass the scope through', () => {
  it('loadSession({ scope }) reads within the tenant', async () => {
    await loadSession(store, { userId: 'alice', sessionId: 's1', scope: ACME })
    expect(cols.session_memory.find.mock.calls[0][0]).toMatchObject({ tenant_id: 'acme' })
  })

  it('createOnFinish reads scope from the per-call context', async () => {
    const onFinish = createOnFinish(store)
    await onFinish({
      steps: [],
      runtimeContext: { userId: 'alice', sessionId: 's1', scope: ACME, prompt: 'hi' },
    })
    expect(cols.session_memory.insertMany.mock.calls[0][0][0]).toMatchObject({
      tenant_id: 'acme',
      user_id: 'alice',
    })
  })

  it('createOnFinish accepts scope in closure mode', async () => {
    const onFinish = createOnFinish(store, {
      userId: 'alice',
      sessionId: 's1',
      scope: ACME,
      prompt: 'hi',
    })
    await onFinish({ steps: [] })
    expect(cols.session_memory.insertMany.mock.calls[0][0][0]).toMatchObject({
      tenant_id: 'acme',
    })
  })
})

