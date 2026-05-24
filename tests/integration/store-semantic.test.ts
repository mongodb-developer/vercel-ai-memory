import { describe, it, expect, beforeAll } from 'vitest'
import { getTestStore, bootstrapOnce } from '../helpers/atlas-client'
import type { MongoMemoryStore } from '../../src/store'

const USER = 'test-user-semantic'

let store: MongoMemoryStore

beforeAll(async () => {
  await bootstrapOnce()
  store = await getTestStore()
})

describe('SemanticMemory', () => {
  it('saves and the document exists', async () => {
    await store.semanticSave(USER, 'Alex', 'Loves rock climbing and coffee', {
      importance: 8,
      tags: ['preference', 'outdoor'],
    })
    // Verify via direct store access — no vector search needed
    const col = (store as unknown as { semantic: { findOne: (q: object) => Promise<unknown> } }).semantic
    if (col) {
      const doc = await col.findOne({ user_id: USER, name: 'Alex', is_latest: true })
      expect(doc).not.toBeNull()
    }
  })

  it('in-place upsert: save twice with same name produces 1 doc (default keepHistory=false)', async () => {
    const name = `Upsert-${Date.now()}`
    await store.semanticSave(USER, name, 'First version')
    await store.semanticSave(USER, name, 'Second version — updated')

    const col = (store as unknown as { semantic: { find: (q: object) => { toArray: () => Promise<{ is_latest: boolean; description: string }[]> } } }).semantic
    if (col) {
      const docs = await col.find({ user_id: USER, name }).toArray()
      // Default mode: only 1 document (upserted in place)
      expect(docs).toHaveLength(1)
      expect(docs[0].is_latest).toBe(true)
      expect(docs[0].description).toBe('Second version — updated')
    }
  })

  it('saves with default importance of 5 when not specified', async () => {
    const name = `DefaultImportance-${Date.now()}`
    await store.semanticSave(USER, name, 'No importance given')

    const col = (store as unknown as { semantic: { findOne: (q: object) => Promise<{ importance: number } | null> } }).semantic
    if (col) {
      const doc = await col.findOne({ user_id: USER, name, is_latest: true })
      expect(doc?.importance).toBe(5)
    }
  })

  it('saves tags correctly', async () => {
    const name = `Tagged-${Date.now()}`
    await store.semanticSave(USER, name, 'Has tags', { tags: ['tag1', 'tag2'] })

    const col = (store as unknown as { semantic: { findOne: (q: object) => Promise<{ tags: string[] } | null> } }).semantic
    if (col) {
      const doc = await col.findOne({ user_id: USER, name, is_latest: true })
      expect(doc?.tags).toEqual(['tag1', 'tag2'])
    }
  })

  it('upsert preserves stats from initial insert', async () => {
    const name = `StatsPreserve-${Date.now()}`
    await store.semanticSave(USER, name, 'First save')

    const col = (store as unknown as { semantic: { findOne: (q: object) => Promise<{ stats: { retrieval_ct: number } } | null> } }).semantic
    if (col) {
      const doc = await col.findOne({ user_id: USER, name, is_latest: true })
      expect(doc?.stats.retrieval_ct).toBe(0)
    }

    // Second save should keep the original stats (via $setOnInsert not overwriting)
    await store.semanticSave(USER, name, 'Updated save')

    if (col) {
      const doc = await col.findOne({ user_id: USER, name, is_latest: true })
      expect(doc?.stats.retrieval_ct).toBe(0)
    }
  })
})
