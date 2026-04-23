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

  it('temporal versioning works for procedures', async () => {
    const task = `Versioned-${Date.now()}`
    await store.proceduralSave(USER, task, 'Version 1 of the procedure')
    await store.proceduralSave(USER, task, 'Version 2 — improved')

    const col = (store as unknown as {
      procedural: { find: (q: object) => { toArray: () => Promise<{ is_latest: boolean; description: string }[]> } }
    }).procedural
    if (col) {
      const docs = await col.find({ user_id: USER, task }).toArray()
      const latest = docs.filter(d => d.is_latest)
      const old = docs.filter(d => !d.is_latest)
      expect(latest).toHaveLength(1)
      expect(old).toHaveLength(1)
      expect(latest[0].description).toBe('Version 2 — improved')
    }
  })
})
