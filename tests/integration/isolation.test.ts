import { describe, it, expect, beforeAll } from 'vitest'
import { ObjectId } from 'mongodb'
import { getTestStore, getTestClient, bootstrapOnce, TEST_DB } from '../helpers/atlas-client'
import type { MongoMemoryStore } from '../../src/store'

/**
 * P0-1 — cross-user isolation against a real Atlas cluster (threat model #3/#9).
 *
 * Alice owns data; Bob knows (or guesses) Alice's ids and session id. Bob must
 * be unable to read, promote, or forget any of it — while Alice's own
 * automatic forget still works.
 */
const ALICE = 'test-iso-alice'
const BOB = 'test-iso-bob'

let store: MongoMemoryStore

beforeAll(async () => {
  await bootstrapOnce()
  store = await getTestStore()
})

async function rawDoc(collection: string, id: ObjectId) {
  const client = await getTestClient()
  return client.db(TEST_DB).collection(collection).findOne({ _id: id })
}

describe('Isolation — forget is owner-scoped', () => {
  it("Bob cannot forget Alice's episodic memory; Alice can", async () => {
    const id = await store.episodicSave(ALICE, 'meeting', 'Alice met the Acme team')

    await expect(store.forget(BOB, 'episodic', id.toString())).resolves.toBe(false)
    expect((await rawDoc('episodic_memory', id))?.expire_at ?? null).toBeNull()

    await expect(store.forget(ALICE, 'episodic', id.toString())).resolves.toBe(true)
    expect((await rawDoc('episodic_memory', id))?.expire_at).toBeInstanceOf(Date)
  })
})

describe('Isolation — session & scratchpad reads', () => {
  it("Bob cannot read Alice's session even with her sessionId", async () => {
    const sess = `iso-sess-${Date.now()}`
    await store.sessionAppend(ALICE, sess, 'user', 'my secret plan')

    expect(await store.sessionRecent(BOB, sess)).toHaveLength(0)
    expect(await store.sessionRecent(ALICE, sess)).toHaveLength(1)
  })

  it("Bob cannot read or promote Alice's scratchpad note", async () => {
    const sess = `iso-scratch-${Date.now()}`
    const noteId = await store.scratchpadWrite(ALICE, sess, 'alice private note')

    expect(await store.scratchpadRead(BOB, sess)).toHaveLength(0)
    await expect(
      store.scratchpadPromote(noteId.toString(), BOB, 'interaction')
    ).rejects.toThrow(/not found/)

    // Note is untouched and still readable by its owner.
    const notes = await store.scratchpadRead(ALICE, sess)
    expect(notes.map((n) => n.note)).toEqual(['alice private note'])
  })

  it('concurrent promotions of one note create exactly one episodic memory', async () => {
    const sess = `iso-race-${Date.now()}`
    const noteId = await store.scratchpadWrite(ALICE, sess, 'promote me once')

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        store.scratchpadPromote(noteId.toString(), ALICE, 'race')
      )
    )
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    expect(fulfilled).toHaveLength(1)

    const client = await getTestClient()
    const episodes = await client
      .db(TEST_DB)
      .collection('episodic_memory')
      .countDocuments({ user_id: ALICE, event_type: 'race', description: 'promote me once' })
    expect(episodes).toBe(1)

    const note = await rawDoc('scratchpad_memory', noteId)
    expect(note?.promoted).toBe(true)
    expect(note?.promoted_to_id).toBeInstanceOf(ObjectId)
  })
})
