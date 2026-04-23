import { describe, it, expect, beforeAll } from 'vitest'
import { getTestStore, bootstrapOnce } from '../helpers/atlas-client'
import type { MongoMemoryStore } from '../../src/store'

const USER = 'test-user-session'
const SESSION = `sess-${Date.now()}`

let store: MongoMemoryStore

beforeAll(async () => {
  await bootstrapOnce()  // idempotent — only runs once across all test files
  store = await getTestStore()
})
// No afterAll teardown — global setup handles DB drop after all test files finish

describe('SessionMemory', () => {
  it('appends a user turn and retrieves it', async () => {
    await store.sessionAppend(USER, SESSION, 'user', 'Hello, my name is Alex')
    const turns = await store.sessionRecent(SESSION)
    expect(turns.length).toBeGreaterThanOrEqual(1)
    const last = turns[turns.length - 1]
    expect(last.role).toBe('user')
    expect(last.content).toBe('Hello, my name is Alex')
    expect(last.session_id).toBe(SESSION)
    expect(last.user_id).toBe(USER)
  })

  it('assigns sequential seq numbers', async () => {
    const sess = `sess-seq-${Date.now()}`
    await store.sessionAppend(USER, sess, 'user', 'First message')
    await store.sessionAppend(USER, sess, 'assistant', 'Second message')
    await store.sessionAppend(USER, sess, 'user', 'Third message')

    const turns = await store.sessionRecent(sess)
    expect(turns).toHaveLength(3)
    expect(turns[0].seq).toBe(0)
    expect(turns[1].seq).toBe(1)
    expect(turns[2].seq).toBe(2)
  })

  it('returns turns in chronological order', async () => {
    const sess = `sess-order-${Date.now()}`
    await store.sessionAppend(USER, sess, 'user', 'msg1')
    await store.sessionAppend(USER, sess, 'assistant', 'msg2')
    await store.sessionAppend(USER, sess, 'user', 'msg3')

    const turns = await store.sessionRecent(sess)
    expect(turns[0].content).toBe('msg1')
    expect(turns[1].content).toBe('msg2')
    expect(turns[2].content).toBe('msg3')
  })

  it('respects limit parameter', async () => {
    const sess = `sess-limit-${Date.now()}`
    for (let i = 0; i < 5; i++) {
      await store.sessionAppend(USER, sess, 'user', `message ${i}`)
    }
    const turns = await store.sessionRecent(sess, 3)
    expect(turns.length).toBeLessThanOrEqual(3)
  })

  it('returns empty array for unknown session', async () => {
    const turns = await store.sessionRecent('nonexistent-session-xyz')
    expect(turns).toHaveLength(0)
  })

  it('stores tool_name for tool role', async () => {
    const sess = `sess-tool-${Date.now()}`
    await store.sessionAppend(USER, sess, 'tool', 'search result', { toolName: 'semantic_search' })
    const turns = await store.sessionRecent(sess)
    expect(turns[0].tool_name).toBe('semantic_search')
    expect(turns[0].role).toBe('tool')
  })

  it('has created_at timestamp', async () => {
    const sess = `sess-ts-${Date.now()}`
    await store.sessionAppend(USER, sess, 'user', 'timestamped message')
    const turns = await store.sessionRecent(sess)
    expect(turns[0].created_at).toBeInstanceOf(Date)
  })
})
