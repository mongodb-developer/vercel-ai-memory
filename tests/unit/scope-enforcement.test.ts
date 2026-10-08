import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObjectId } from 'mongodb'
import type { MongoClient } from 'mongodb'
import { MongoMemoryStore } from '../../src/store'
import { EmbeddingAdapter } from '../../src/embeddings'
import { mockEmbedder } from '../helpers/mock-embedder'

/**
 * P0-1 — Tenant / user isolation at the store boundary (threat model #3, #9).
 *
 * These tests inspect the exact MongoDB filters the store issues, proving that
 * every read / write / forget is constrained by the trusted owner scope. No
 * network: the MongoClient is a stub that records each call.
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

let cols: Record<string, Col>
let store: MongoMemoryStore

beforeEach(() => {
  cols = {}
  const db = {
    collection: (name: string) => (cols[name] ??= makeCol()),
    command: vi.fn(),
  }
  const client = { db: () => db } as unknown as MongoClient
  store = new MongoMemoryStore(client, new EmbeddingAdapter(mockEmbedder), 'test_db')
})

const ID = '507f1f77bcf86cd799439011'

describe('forget — automatic, but only within the caller scope', () => {
  it("filters on { _id, user_id } so another user's doc can never match", async () => {
    await store.forget('alice', 'semantic', ID)
    const [filter, update] = cols.semantic_memory.updateOne.mock.calls[0]
    expect(filter).toEqual({ _id: new ObjectId(ID), user_id: 'alice' })
    expect(update.$set.expire_at).toBeInstanceOf(Date)
  })

  it('returns false (nothing modified) when the id is not owned by the caller', async () => {
    cols.episodic_memory.updateOne.mockResolvedValue({ matchedCount: 0 })
    await expect(store.forget('bob', 'episodic', ID)).resolves.toBe(false)
  })

  it.each(['session', 'semantic', 'procedural', 'episodic', 'scratchpad'] as const)(
    'scopes %s forget by user_id',
    async (type) => {
      await store.forget('alice', type, ID)
      expect(cols[`${type}_memory`].updateOne.mock.calls[0][0]).toMatchObject({
        user_id: 'alice',
      })
    }
  )

  it('rejects malformed ids without querying', async () => {
    await expect(store.forget('alice', 'semantic', 'not-an-id')).resolves.toBe(false)
    expect(cols.semantic_memory.updateOne).not.toHaveBeenCalled()
  })

  it('rejects unknown memory types', async () => {
    await expect(store.forget('alice', 'admin' as never, ID)).rejects.toThrow(
      /Unknown memory type/
    )
  })

  it('throws on a missing scope instead of acting unscoped', async () => {
    await expect(store.forget('', 'semantic', ID)).rejects.toThrow(/userId/)
    await expect(store.forget(undefined as never, 'semantic', ID)).rejects.toThrow(/userId/)
    expect(cols.semantic_memory.updateOne).not.toHaveBeenCalled()
  })
})

describe('session / scratchpad reads are owner-scoped', () => {
  it('sessionRecent filters by user_id AND session_id', async () => {
    await store.sessionRecent('alice', 'sess-1', 5)
    expect(cols.session_memory.find.mock.calls[0][0]).toEqual({
      user_id: 'alice',
      session_id: 'sess-1',
    })
  })

  it('scratchpadRead filters by user_id AND session_id', async () => {
    await store.scratchpadRead('alice', 'sess-1')
    expect(cols.scratchpad_memory.find.mock.calls[0][0]).toEqual({
      user_id: 'alice',
      session_id: 'sess-1',
      promoted: false,
    })
  })

  it('scratchpadPromote only promotes a note owned by the caller', async () => {
    await expect(store.scratchpadPromote(ID, 'bob', 'interaction')).rejects.toThrow(/not found/)
    expect(cols.scratchpad_memory.findOneAndUpdate.mock.calls[0][0]).toEqual({
      _id: new ObjectId(ID),
      user_id: 'bob',
      promoted: false,
    })
    // Nothing leaked into bob's episodic memory.
    expect(cols.episodic_memory.insertOne).not.toHaveBeenCalled()
  })

  it('scratchpadPromote atomically claims the note, then records the episodic id', async () => {
    const noteId = new ObjectId(ID)
    cols.scratchpad_memory.findOneAndUpdate.mockResolvedValue({
      _id: noteId,
      user_id: 'alice',
      note: 'private note',
    })

    const { episodicId } = await store.scratchpadPromote(ID, 'alice', 'interaction')

    expect(cols.scratchpad_memory.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: noteId, user_id: 'alice', promoted: false },
      { $set: { promoted: true } },
      { returnDocument: 'before' }
    )
    expect(cols.scratchpad_memory.findOne).not.toHaveBeenCalled()
    expect(cols.episodic_memory.insertOne.mock.calls[0][0]).toMatchObject({
      user_id: 'alice',
      description: 'private note',
    })
    expect(cols.scratchpad_memory.updateOne).toHaveBeenCalledWith(
      { _id: noteId, user_id: 'alice' },
      { $set: { promoted_to_id: episodicId } }
    )
  })

  it('scratchpadPromote releases its claim if the episodic write fails', async () => {
    const noteId = new ObjectId(ID)
    cols.scratchpad_memory.findOneAndUpdate.mockResolvedValue({
      _id: noteId,
      user_id: 'alice',
      note: 'private note',
    })
    cols.episodic_memory.insertOne.mockRejectedValue(new Error('write failed'))

    await expect(store.scratchpadPromote(ID, 'alice', 'interaction')).rejects.toThrow(
      /write failed/
    )
    expect(cols.scratchpad_memory.updateOne).toHaveBeenCalledWith(
      { _id: noteId, user_id: 'alice', promoted_to_id: { $exists: false } },
      { $set: { promoted: false } }
    )
  })

  it('scratchpadPromote rejects malformed ids without querying', async () => {
    await expect(store.scratchpadPromote('nope', 'bob', 'interaction')).rejects.toThrow(
      /not found/
    )
    expect(cols.scratchpad_memory.findOneAndUpdate).not.toHaveBeenCalled()
  })

  it('episodicExists cannot override the owner scope through its filter', async () => {
    await store.episodicExists('alice', { user_id: 'bob', event_type: 'login' })
    expect(cols.episodic_memory.findOne.mock.calls[0][0]).toEqual({
      event_type: 'login',
      user_id: 'alice',
    })
  })
})

describe('fail-closed scope validation on every public method', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['sessionAppend (userId)', () => store.sessionAppend('', 's', 'user', 'hi')],
    ['sessionAppend (sessionId)', () => store.sessionAppend('u', '', 'user', 'hi')],
    ['sessionRecent', () => store.sessionRecent('u', '')],
    ['semanticSave', () => store.semanticSave('', 'n', 'd')],
    ['semanticSearch', () => store.semanticSearch('  ', 'q')],
    ['proceduralSave', () => store.proceduralSave('', 't', 'd')],
    ['proceduralSearch', () => store.proceduralSearch('', 'q')],
    ['episodicSave', () => store.episodicSave('', 'e', 'd')],
    ['episodicSearch', () => store.episodicSearch('', 'q')],
    ['episodicExists', () => store.episodicExists('', {})],
    ['scratchpadWrite', () => store.scratchpadWrite('u', '', 'n')],
    ['scratchpadRead', () => store.scratchpadRead('', 's')],
    ['scratchpadPromote', () => store.scratchpadPromote(ID, '', 'e')],
  ]

  it.each(cases)('%s throws on empty scope', async (_name, call) => {
    await expect(call()).rejects.toThrow(/is required and must be a non-empty string/)
  })

  it('no collection is touched when scope is missing', async () => {
    await Promise.allSettled(cases.map(([, call]) => call()))
    for (const col of Object.values(cols)) {
      for (const fn of Object.values(col)) expect(fn).not.toHaveBeenCalled()
    }
  })
})
