import { describe, it, expect, beforeAll } from 'vitest'
import { ObjectId } from 'mongodb'
import { getTestStore, bootstrapOnce } from '../helpers/atlas-client'
import type { MongoMemoryStore } from '../../src/store'

const USER = 'test-user-scratchpad'

let store: MongoMemoryStore

beforeAll(async () => {
  await bootstrapOnce()
  store = await getTestStore()
})

describe('ScratchpadMemory', () => {
  it('writes a note and returns an ObjectId', async () => {
    const sess = `scratchpad-sess-${Date.now()}`
    const id = await store.scratchpadWrite(USER, sess, 'User seems interested in beginner climbing routes')
    expect(id).toBeInstanceOf(ObjectId)
  })

  it('reads notes for the current session', async () => {
    const sess = `read-sess-${Date.now()}`
    await store.scratchpadWrite(USER, sess, 'Note one')
    await store.scratchpadWrite(USER, sess, 'Note two')

    const notes = await store.scratchpadRead(sess)
    expect(notes).toHaveLength(2)
    expect(notes.map(n => n.note)).toContain('Note one')
    expect(notes.map(n => n.note)).toContain('Note two')
  })

  it('returns only unpromoted notes', async () => {
    const sess = `promoted-sess-${Date.now()}`
    const id = await store.scratchpadWrite(USER, sess, 'Will be promoted')
    await store.scratchpadWrite(USER, sess, 'Will stay')

    // Promote the first note
    await store.scratchpadPromote(id.toString(), USER, 'interaction')

    const notes = await store.scratchpadRead(sess)
    expect(notes).toHaveLength(1)
    expect(notes[0].note).toBe('Will stay')
  })

  it('promote creates an episodic memory entry', async () => {
    const sess = `promote-ep-${Date.now()}`
    const id = await store.scratchpadWrite(USER, sess, 'User mentioned they dislike crowded gyms')
    const { episodicId } = await store.scratchpadPromote(id.toString(), USER, 'preference', {
      importance: 6,
    })

    expect(episodicId).toBeInstanceOf(ObjectId)

    const col = (store as unknown as {
      episodic: { findOne: (q: object) => Promise<{ description: string; event_type: string } | null> }
    }).episodic
    if (col) {
      const ep = await col.findOne({ _id: episodicId })
      expect(ep?.description).toBe('User mentioned they dislike crowded gyms')
      expect(ep?.event_type).toBe('preference')
    }
  })

  it('throws when promoting a non-existent scratchpad id', async () => {
    const fakeId = new ObjectId().toString()
    await expect(
      store.scratchpadPromote(fakeId, USER, 'interaction')
    ).rejects.toThrow()
  })

  it('reads notes in chronological order', async () => {
    const sess = `order-sess-${Date.now()}`
    await store.scratchpadWrite(USER, sess, 'First')
    await store.scratchpadWrite(USER, sess, 'Second')
    await store.scratchpadWrite(USER, sess, 'Third')

    const notes = await store.scratchpadRead(sess)
    expect(notes[0].note).toBe('First')
    expect(notes[1].note).toBe('Second')
    expect(notes[2].note).toBe('Third')
  })
})
