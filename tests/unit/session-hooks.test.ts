import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ObjectId } from 'mongodb'
import {
  loadSession,
  createOnFinish,
  type OnFinishCallback,
} from '../../src/session-hooks'
import type { MongoMemoryStore } from '../../src/store'
import type { SessionMemory } from '../../src/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTurn(
  role: SessionMemory['role'],
  content: string,
  seq: number,
  extra?: Partial<SessionMemory>
): SessionMemory {
  return {
    _id: new ObjectId(),
    session_id: 'sess-1',
    user_id: 'user-1',
    seq,
    role,
    content,
    created_at: new Date(),
    ...extra,
  }
}

function makeMockStore() {
  return {
    sessionAppend: vi.fn(async () => undefined),
    sessionRecent: vi.fn(async () => [] as SessionMemory[]),
  } as unknown as MongoMemoryStore & {
    sessionAppend: ReturnType<typeof vi.fn>
    sessionRecent: ReturnType<typeof vi.fn>
  }
}

// Minimal OnFinishEvent-shaped factory for tests.
function makeEvent(
  steps: Array<{
    messages: Array<{ role: 'assistant' | 'tool'; content: unknown }>
  }>,
  context?: Record<string, unknown>
) {
  return {
    steps: steps.map((s, i) => ({
      stepNumber: i,
      response: { messages: s.messages },
    })),
    experimental_context: context,
  } as unknown as Parameters<OnFinishCallback>[0]
}

// ─── loadSession ──────────────────────────────────────────────────────────────

describe('loadSession', () => {
  it('returns empty array when no history exists', async () => {
    const store = makeMockStore()
    store.sessionRecent.mockResolvedValue([])

    const msgs = await loadSession(store, { userId: 'u', sessionId: 's' })

    expect(msgs).toEqual([])
    expect(store.sessionRecent).toHaveBeenCalledWith('s', undefined)
  })

  it('maps user and assistant turns to the right ModelMessage shape', async () => {
    const store = makeMockStore()
    store.sessionRecent.mockResolvedValue([
      makeTurn('user', 'hello', 0),
      makeTurn('assistant', 'hi!', 1),
      makeTurn('user', 'how are you?', 2),
    ])

    const msgs = await loadSession(store, { userId: 'u', sessionId: 's' })

    expect(msgs).toHaveLength(3)
    expect(msgs[0]).toEqual({ role: 'user', content: 'hello' })
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'hi!' })
    expect(msgs[2]).toEqual({ role: 'user', content: 'how are you?' })
  })

  it('maps tool turns to a tool ModelMessage with tool-result part', async () => {
    const store = makeMockStore()
    store.sessionRecent.mockResolvedValue([
      makeTurn('tool', 'search result', 0, { tool_name: 'semantic_search' }),
    ])

    const msgs = await loadSession(store, { userId: 'u', sessionId: 's' })

    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('tool')
    const content = (msgs[0] as { content: unknown[] }).content
    expect(Array.isArray(content)).toBe(true)
    expect(content[0]).toMatchObject({
      type: 'tool-result',
      toolName: 'semantic_search',
      output: { type: 'text', value: 'search result' },
    })
  })

  it('forwards limit to sessionRecent', async () => {
    const store = makeMockStore()
    store.sessionRecent.mockResolvedValue([])

    await loadSession(store, { userId: 'u', sessionId: 's', limit: 10 })
    expect(store.sessionRecent).toHaveBeenCalledWith('s', 10)
  })
})

// ─── createOnFinish — closure mode ────────────────────────────────────────────

describe('createOnFinish (closure mode)', () => {
  let store: ReturnType<typeof makeMockStore>
  beforeEach(() => {
    store = makeMockStore()
  })

  it('persists the user prompt exactly once when provided as a string', async () => {
    const cb = createOnFinish(store, {
      userId: 'u',
      sessionId: 's',
      prompt: 'hello world',
    })
    await cb(makeEvent([]))

    expect(store.sessionAppend).toHaveBeenCalledTimes(1)
    expect(store.sessionAppend).toHaveBeenCalledWith(
      'u',
      's',
      'user',
      'hello world'
    )
  })

  it('skips prompt persistence when persistUserPrompt is false', async () => {
    const cb = createOnFinish(store, {
      userId: 'u',
      sessionId: 's',
      prompt: 'hello',
      persistUserPrompt: false,
    })
    await cb(makeEvent([]))

    expect(store.sessionAppend).not.toHaveBeenCalled()
  })

  it('persists one assistant message from a single step', async () => {
    const cb = createOnFinish(store, { userId: 'u', sessionId: 's' })
    await cb(
      makeEvent([
        {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'the answer is 42' }],
            },
          ],
        },
      ])
    )

    expect(store.sessionAppend).toHaveBeenCalledTimes(1)
    expect(store.sessionAppend).toHaveBeenCalledWith(
      'u',
      's',
      'assistant',
      'the answer is 42'
    )
  })

  it('persists assistant text content that is a plain string', async () => {
    const cb = createOnFinish(store, { userId: 'u', sessionId: 's' })
    await cb(
      makeEvent([{ messages: [{ role: 'assistant', content: 'hi there' }] }])
    )

    expect(store.sessionAppend).toHaveBeenCalledWith(
      'u',
      's',
      'assistant',
      'hi there'
    )
  })

  it('persists tool-result messages with toolName', async () => {
    const cb = createOnFinish(store, { userId: 'u', sessionId: 's' })
    await cb(
      makeEvent([
        {
          messages: [
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'call-1',
                  toolName: 'semantic_search',
                  output: { type: 'text', value: 'result text' },
                },
              ],
            },
          ],
        },
      ])
    )

    expect(store.sessionAppend).toHaveBeenCalledWith(
      'u',
      's',
      'tool',
      'result text',
      { toolName: 'semantic_search' }
    )
  })

  it('persists a full tool-loop: user → assistant(tool-call) → tool → assistant(final)', async () => {
    const cb = createOnFinish(store, {
      userId: 'u',
      sessionId: 's',
      prompt: 'search my prefs',
    })
    await cb(
      makeEvent([
        {
          messages: [
            {
              role: 'assistant',
              content: [
                {
                  type: 'tool-call',
                  toolCallId: 'call-1',
                  toolName: 'semantic_search',
                  input: {},
                },
              ],
            },
            {
              role: 'tool',
              content: [
                {
                  type: 'tool-result',
                  toolCallId: 'call-1',
                  toolName: 'semantic_search',
                  output: { type: 'text', value: 'user likes coffee' },
                },
              ],
            },
          ],
        },
        {
          messages: [
            {
              role: 'assistant',
              content: [{ type: 'text', text: 'You like coffee.' }],
            },
          ],
        },
      ])
    )

    // user + assistant(tool-call marker) + tool + final assistant = 4
    expect(store.sessionAppend).toHaveBeenCalledTimes(4)
    const calls = store.sessionAppend.mock.calls
    expect(calls[0]).toEqual(['u', 's', 'user', 'search my prefs'])
    expect(calls[1][2]).toBe('assistant') // the tool-call marker
    expect(calls[2]).toEqual([
      'u',
      's',
      'tool',
      'user likes coffee',
      { toolName: 'semantic_search' },
    ])
    expect(calls[3]).toEqual(['u', 's', 'assistant', 'You like coffee.'])
  })

  it('swallows and logs persistence errors without throwing', async () => {
    store.sessionAppend.mockRejectedValueOnce(new Error('DB down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const cb = createOnFinish(store, {
      userId: 'u',
      sessionId: 's',
      prompt: 'x',
    })
    await expect(cb(makeEvent([]))).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()

    warn.mockRestore()
  })
})

// ─── createOnFinish — context mode (experimental_context) ─────────────────────

describe('createOnFinish (context mode)', () => {
  it('reads userId/sessionId/prompt from experimental_context when opts are omitted', async () => {
    const store = makeMockStore()
    const cb = createOnFinish(store) // no opts

    await cb(
      makeEvent(
        [{ messages: [{ role: 'assistant', content: 'hi' }] }],
        { userId: 'ctx-user', sessionId: 'ctx-sess', prompt: 'hello' }
      )
    )

    expect(store.sessionAppend).toHaveBeenCalledWith(
      'ctx-user',
      'ctx-sess',
      'user',
      'hello'
    )
    expect(store.sessionAppend).toHaveBeenCalledWith(
      'ctx-user',
      'ctx-sess',
      'assistant',
      'hi'
    )
  })

  it('warns and no-ops when neither opts nor context provide scope', async () => {
    const store = makeMockStore()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cb = createOnFinish(store)

    await cb(makeEvent([{ messages: [{ role: 'assistant', content: 'hi' }] }]))

    expect(store.sessionAppend).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('context overrides opts per-call', async () => {
    const store = makeMockStore()
    const cb = createOnFinish(store, {
      userId: 'default-user',
      sessionId: 'default-sess',
    })

    await cb(
      makeEvent(
        [{ messages: [{ role: 'assistant', content: 'hi' }] }],
        { userId: 'override-user', sessionId: 'override-sess' }
      )
    )

    expect(store.sessionAppend).toHaveBeenCalledWith(
      'override-user',
      'override-sess',
      'assistant',
      'hi'
    )
  })
})
