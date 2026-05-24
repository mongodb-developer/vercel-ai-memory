import { describe, it, expect, beforeAll } from 'vitest'
import { getTestStore, bootstrapOnce } from '../helpers/atlas-client'
import { loadSession, createOnFinish } from '../../src/session-hooks'
import type { MongoMemoryStore } from '../../src/store'

const USER = 'test-user-hooks'

let store: MongoMemoryStore

beforeAll(async () => {
  await bootstrapOnce()
  store = await getTestStore()
})

// Build a minimally-shaped OnFinishEvent. The real event type is complex, but
// our hook only reads `steps[].response.messages` and `experimental_context`.
function makeEvent(
  steps: Array<{ messages: Array<{ role: 'assistant' | 'tool'; content: unknown }> }>,
  context?: Record<string, unknown>
) {
  return {
    steps: steps.map((s, i) => ({
      stepNumber: i,
      response: { messages: s.messages },
    })),
    experimental_context: context,
  } as unknown as Parameters<ReturnType<typeof createOnFinish>>[0]
}

describe('session hooks — end to end against Atlas', () => {
  it('persists exactly 2N turns across N round-trips (no duplicates, no drops)', async () => {
    const sessionId = `hooks-e2e-${Date.now()}`
    const onFinish = createOnFinish(store)

    const turns: Array<{ prompt: string; reply: string }> = [
      { prompt: "Hi, I'm Alex.", reply: 'Hello Alex!' },
      { prompt: 'What is my name?', reply: 'Your name is Alex.' },
      { prompt: 'Remember I like climbing.', reply: "Got it — you like climbing." },
    ]

    for (const turn of turns) {
      await onFinish(
        makeEvent(
          [
            {
              messages: [
                {
                  role: 'assistant',
                  content: [{ type: 'text', text: turn.reply }],
                },
              ],
            },
          ],
          { userId: USER, sessionId, prompt: turn.prompt }
        )
      )
    }

    const persisted = await store.sessionRecent(sessionId, 100)
    expect(persisted).toHaveLength(turns.length * 2)

    // Order: user / assistant / user / assistant / ...
    for (let i = 0; i < turns.length; i++) {
      const userDoc = persisted[i * 2]
      const asstDoc = persisted[i * 2 + 1]
      expect(userDoc.role).toBe('user')
      expect(userDoc.content).toBe(turns[i].prompt)
      expect(asstDoc.role).toBe('assistant')
      expect(asstDoc.content).toBe(turns[i].reply)
    }
  })

  it('loadSession restores the transcript as ModelMessage[] in order', async () => {
    const sessionId = `hooks-load-${Date.now()}`
    const onFinish = createOnFinish(store, { userId: USER, sessionId })

    // Write two turns via hook.
    await onFinish(
      makeEvent(
        [{ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hi!' }] }] }],
        { userId: USER, sessionId, prompt: 'hello' }
      )
    )
    await onFinish(
      makeEvent(
        [{ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'bye!' }] }] }],
        { userId: USER, sessionId, prompt: 'goodbye' }
      )
    )

    const msgs = await loadSession(store, { userId: USER, sessionId })
    expect(msgs).toHaveLength(4)
    expect(msgs[0]).toEqual({ role: 'user', content: 'hello' })
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'hi!' })
    expect(msgs[2]).toEqual({ role: 'user', content: 'goodbye' })
    expect(msgs[3]).toEqual({ role: 'assistant', content: 'bye!' })
  })

  it('captures tool turns produced inside a multi-step tool loop', async () => {
    const sessionId = `hooks-toolloop-${Date.now()}`
    const onFinish = createOnFinish(store)

    await onFinish(
      makeEvent(
        [
          // Step 1: assistant decides to call a tool; tool responds.
          {
            messages: [
              {
                role: 'assistant',
                content: [
                  {
                    type: 'tool-call',
                    toolCallId: 'c1',
                    toolName: 'semantic_search',
                    input: { q: 'prefs' },
                  },
                ],
              },
              {
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolCallId: 'c1',
                    toolName: 'semantic_search',
                    output: { type: 'text', value: 'found: likes climbing' },
                  },
                ],
              },
            ],
          },
          // Step 2: assistant writes the final answer.
          {
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'text', text: 'You like climbing.' }],
              },
            ],
          },
        ],
        { userId: USER, sessionId, prompt: 'what do I like?' }
      )
    )

    const persisted = await store.sessionRecent(sessionId, 100)
    // user + assistant(tool-call marker) + tool + assistant(final) = 4
    expect(persisted).toHaveLength(4)

    expect(persisted[0].role).toBe('user')
    expect(persisted[0].content).toBe('what do I like?')

    expect(persisted[1].role).toBe('assistant')
    expect(persisted[1].content).toContain('[tool-call: semantic_search]')

    expect(persisted[2].role).toBe('tool')
    expect(persisted[2].content).toBe('found: likes climbing')
    expect(persisted[2].tool_name).toBe('semantic_search')

    expect(persisted[3].role).toBe('assistant')
    expect(persisted[3].content).toBe('You like climbing.')

    const restored = await loadSession(store, { userId: USER, sessionId })
    expect(restored).toEqual([
      { role: 'user', content: 'what do I like?' },
      { role: 'assistant', content: '[tool-call: semantic_search]' },
      { role: 'assistant', content: 'You like climbing.' },
    ])
  })
})
