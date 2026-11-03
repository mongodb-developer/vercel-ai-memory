import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import * as ai from 'ai'
import * as aiTest from 'ai/test'
import { createOnFinish } from '../../src/session-hooks'
import type { MongoMemoryStore } from '../../src/store'

/**
 * Context-mode regression test against the REAL installed AI SDK.
 *
 * Earlier tests hand-built the end event, so they could not notice that AI SDK
 * v7 renamed `experimental_context` to `runtimeContext` and `onFinish` to
 * `onEnd`. This test drives an actual `ToolLoopAgent` with a mock model and
 * wires the hook the way each major documents it. CI runs it on v6 and v7.
 */
const aiVersion: string = createRequire(import.meta.url)('ai/package.json').version
const major = Number(aiVersion.split('.')[0])

/* eslint-disable @typescript-eslint/no-explicit-any */
const sdk = ai as any
const testing = aiTest as any

function mockModel() {
  const Mock = testing.MockLanguageModelV4 ?? testing.MockLanguageModelV3
  return new Mock({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Hello Alex!' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 1, text: 1, reasoning: undefined },
      },
      warnings: [],
    }),
  })
}

function mockStore() {
  return { sessionAppendMany: vi.fn(async () => undefined) } as unknown as MongoMemoryStore & {
    sessionAppendMany: ReturnType<typeof vi.fn>
  }
}

/** Context key and end-callback name that this AI SDK major expects. */
const contextKey = major >= 7 ? 'runtimeContext' : 'experimental_context'
const endCallback = major >= 7 ? 'onEnd' : 'onFinish'

describe(`createOnFinish context mode with a real ToolLoopAgent (ai@${aiVersion})`, () => {
  it(`persists the turn when scope is passed via ${contextKey} + ${endCallback}`, async () => {
    const store = mockStore()
    const agent = new sdk.ToolLoopAgent({
      model: mockModel(),
      prepareCall: async ({ options, ...settings }: any) => ({
        ...settings,
        [contextKey]: { userId: options.userId, sessionId: options.sessionId, prompt: options.prompt },
      }),
      [endCallback]: createOnFinish(store),
    })

    await agent.generate({
      prompt: 'Hi, I am Alex.',
      options: { userId: 'alice', sessionId: 'sess-1', prompt: 'Hi, I am Alex.' },
    })

    expect(store.sessionAppendMany).toHaveBeenCalledTimes(1)
    expect(store.sessionAppendMany).toHaveBeenCalledWith('alice', 'sess-1', [
      { role: 'user', content: 'Hi, I am Alex.' },
      { role: 'assistant', content: 'Hello Alex!' },
    ])
  })

  it('closure mode persists the turn without any per-call context', async () => {
    const store = mockStore()
    const agent = new sdk.ToolLoopAgent({
      model: mockModel(),
      [endCallback]: createOnFinish(store, {
        userId: 'bob',
        sessionId: 'sess-2',
        prompt: 'Hello',
      }),
    })

    await agent.generate({ prompt: 'Hello' })

    expect(store.sessionAppendMany).toHaveBeenCalledWith('bob', 'sess-2', [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hello Alex!' },
    ])
  })
})