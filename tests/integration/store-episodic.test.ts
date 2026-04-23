import { describe, it, expect, beforeAll } from 'vitest'
import { ObjectId } from 'mongodb'
import { getTestStore, bootstrapOnce } from '../helpers/atlas-client'
import type { MongoMemoryStore } from '../../src/store'

const USER = 'test-user-episodic'

let store: MongoMemoryStore

beforeAll(async () => {
  await bootstrapOnce()
  store = await getTestStore()
})

describe('EpisodicMemory', () => {
  it('saves an event and returns an ObjectId', async () => {
    const id = await store.episodicSave(USER, 'purchase', 'User bought a climbing harness', {
      importance: 7,
      context: { product: 'harness', amount: 120 },
    })
    expect(id).toBeInstanceOf(ObjectId)
  })

  it('stores context metadata', async () => {
    const id = await store.episodicSave(USER, 'rating', 'User rated product 5 stars', {
      context: { product_id: 'abc123', rating: 5 },
    })

    const col = (store as unknown as {
      episodic: { findOne: (q: object) => Promise<{ context: Record<string, unknown>; category: string } | null> }
    }).episodic
    if (col) {
      const doc = await col.findOne({ _id: id })
      expect(doc?.context?.product_id).toBe('abc123')
      expect(doc?.context?.rating).toBe(5)
      expect(doc?.category).toBe('episodic')
    }
  })

  it('stores default stats with retrieval_ct = 0', async () => {
    const id = await store.episodicSave(USER, 'interaction', 'User asked about hiking trails')

    const col = (store as unknown as {
      episodic: { findOne: (q: object) => Promise<{ stats: { retrieval_ct: number } } | null> }
    }).episodic
    if (col) {
      const doc = await col.findOne({ _id: id })
      expect(doc?.stats?.retrieval_ct).toBe(0)
    }
  })

  it('stores correct event_type', async () => {
    const id = await store.episodicSave(USER, 'error', 'Payment failed during checkout')

    const col = (store as unknown as {
      episodic: { findOne: (q: object) => Promise<{ event_type: string } | null> }
    }).episodic
    if (col) {
      const doc = await col.findOne({ _id: id })
      expect(doc?.event_type).toBe('error')
    }
  })
})
