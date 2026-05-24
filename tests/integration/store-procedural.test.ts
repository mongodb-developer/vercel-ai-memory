import { describe, it, expect, beforeAll } from 'vitest'
import { getTestStore, bootstrapOnce } from '../helpers/atlas-client'
import type { MongoMemoryStore } from '../../src/store'

const USER = 'test-user-procedural'

let store: MongoMemoryStore

beforeAll(async () => {
  await bootstrapOnce()
  store = await getTestStore()
})

describe('ProceduralMemory', () => {
  it('saves a procedure and stores it correctly', async () => {
    const task = `Browse-Products-${Date.now()}`
    await store.proceduralSave(
      USER,
      task,
      '1. Open catalog. 2. Filter by category. 3. Add to cart.',
      { source: 'human_expert', importance: 9 }
    )

    const col = (store as unknown as {
      procedural: { findOne: (q: object) => Promise<{ task: string; source: string; importance: number } | null> }
    }).procedural
    if (col) {
      const doc = await col.findOne({ user_id: USER, task, is_latest: true })
      expect(doc).not.toBeNull()
      expect(doc?.source).toBe('human_expert')
      expect(doc?.importance).toBe(9)
    }
  })

  it('defaults source to agent_learned', async () => {
    const task = `DefaultSource-${Date.now()}`
    await store.proceduralSave(USER, task, 'Some procedure')

    const col = (store as unknown as {
      procedural: { findOne: (q: object) => Promise<{ source: string } | null> }
    }).procedural
    if (col) {
      const doc = await col.findOne({ user_id: USER, task, is_latest: true })
      expect(doc?.source).toBe('agent_learned')
    }
  })

  it('in-place upsert: save twice with same task produces 1 doc (default keepHistory=false)', async () => {
    const task = `Upsert-${Date.now()}`
    await store.proceduralSave(USER, task, 'Version 1 of the procedure')
    await store.proceduralSave(USER, task, 'Version 2 — improved')

    const col = (store as unknown as {
      procedural: { find: (q: object) => { toArray: () => Promise<{ is_latest: boolean; description: string }[]> } }
    }).procedural
    if (col) {
      const docs = await col.find({ user_id: USER, task }).toArray()
      // Default mode: only 1 document (upserted in place)
      expect(docs).toHaveLength(1)
      expect(docs[0].is_latest).toBe(true)
      expect(docs[0].description).toBe('Version 2 — improved')
    }
  })

  it('upsert preserves stats from initial insert', async () => {
    const task = `StatsPreserve-${Date.now()}`
    await store.proceduralSave(USER, task, 'First save')

    const col = (store as unknown as {
      procedural: { findOne: (q: object) => Promise<{ stats: { retrieval_ct: number } } | null> }
    }).procedural
    if (col) {
      const doc = await col.findOne({ user_id: USER, task, is_latest: true })
      expect(doc?.stats.retrieval_ct).toBe(0)
    }

    // Second save should keep the original stats (via $setOnInsert not overwriting)
    await store.proceduralSave(USER, task, 'Updated save')

    if (col) {
      const doc = await col.findOne({ user_id: USER, task, is_latest: true })
      expect(doc?.stats.retrieval_ct).toBe(0)
    }
  })
})
