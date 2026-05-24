/**
 * @example Deterministic Session Memory (hook-based)
 *
 * Shows the *recommended production pattern* for session memory:
 *   - `session_*` tool commands are DISABLED, so the LLM can't forget to use them.
 *   - `mongodbMemory.loadSession()` restores conversation history before every call.
 *   - `mongodbMemory.onFinish()` persists every user / assistant / tool turn, exactly once per generation.
 *
 * The LLM keeps the non-deterministic memory *tools* it should have discretion over
 * (semantic_save, episodic_save, procedural_save, scratchpad_*, memory_forget, and their
 * _search counterparts) — but the conversation transcript is captured by the runtime.
 *
 * Prerequisites:
 *   - MongoDB Atlas cluster with vector search enabled (M10+)
 *   - npm install @ai-sdk/openai ai zod
 *   - MONGODB_URI environment variable set
 *   - OPENAI_API_KEY environment variable set
 *
 * Run:
 *   npx tsx examples/deterministic-agent.ts
 */

import { createMongoDBMemory } from '../src/index'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openai } = require('@ai-sdk/openai')
import { ToolLoopAgent, isLoopFinished } from 'ai'
import { z } from 'zod'

// ── 1. Create the memory instance ONCE ────────────────────────────────────────
// `topology.hideToolCommands: ['session']` removes session_append / session_recent
// from the LLM-facing tool surface — BUT keeps the session collection, indexes,
// and store methods live. The runtime drives session writes deterministically
// via loadSession / onFinish below.
//
// (Use `topology.disable` instead if you want the session collection entirely off.)
const mongodbMemory = createMongoDBMemory({
  uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
  embedder: openai.embedding('text-embedding-3-small'),
  dbName: 'agent_memory_example_deterministic',
  topology: { hideToolCommands: ['session'] },
})

// ── 2. Reusable agent with deterministic session wiring ──────────────────────
//
// `onFinish` is set ONCE at construction (ToolLoopAgent only accepts it there)
// and reads per-call scope from `experimental_context` on each generate() call.
//
const agent = new ToolLoopAgent({
  model: openai('gpt-4o-mini'),

  callOptionsSchema: z.object({
    userId: z.string(),
    sessionId: z.string(),
    prompt: z.string(),
  }),

  // NOTE: we strip `prompt` and `messages` out of the incoming `settings` before
  // spreading, because the AI SDK enforces `prompt` XOR `messages` on the
  // returned prepareCall object. We're replacing whatever came in with our own
  // `messages` array (restored history + the new user turn).
  prepareCall: async ({ options, prompt: _p, messages: _m, ...settings }) => {
    const { userId, sessionId, prompt } = options!

    const history = await mongodbMemory.loadSession({ userId, sessionId })

    return {
      ...settings,
      tools: mongodbMemory({ userId, sessionId }),
      // Prepend restored history, then the new user turn.
      messages: [...history, { role: 'user', content: prompt }],
      // `experimental_context` is the ONLY way to pass per-call state to
      // `onFinish` since ToolLoopAgent only accepts `onFinish` at construction.
      // Our hook reads userId/sessionId/prompt from here.
      experimental_context: { userId, sessionId, prompt },
      instructions: `You are a helpful assistant with persistent long-term memory.

When you learn something important about the user:
- Personal facts (name, preferences, interests) → semantic_save
- Events and outcomes → episodic_save
- How-to knowledge → procedural_save

Conversation history is managed for you automatically — you do NOT need to call
session_append or session_recent; they're not available. Respond naturally.`,
    }
  },

  // Deterministic write: every user/assistant/tool turn lands in Mongo,
  // scoped per-call via experimental_context below.
  onFinish: mongodbMemory.onFinish(),

  stopWhen: isLoopFinished(),
})

// ── 3. Chat helper — delegates to the agent ───────────────────────────────────
async function chat(userId: string, sessionId: string, prompt: string): Promise<string> {
  const result = await agent.generate({
    prompt,
    options: { userId, sessionId, prompt },
  })
  return result.text
}

// ── 4. Demo ───────────────────────────────────────────────────────────────────
async function main() {
  const userId = 'demo-user'
  const sessionId = `session-${Date.now()}`

  console.log('=== MongoDB Memory Agent Demo (Deterministic / hook-based) ===\n')

  await mongodbMemory.connect()
  console.log('✅ Connected to MongoDB Atlas\n')

  const turns = [
    'Hi! My name is Alex and I really enjoy rock climbing and coffee.',
    'What do you know about me so far?',
    'I just completed my first lead climb today — a 5.10a route!',
    "Do you remember what I just told you about my climb?",
  ]

  for (const prompt of turns) {
    console.log(`User: ${prompt}`)
    const reply = await chat(userId, sessionId, prompt)
    console.log(`Agent: ${reply}\n`)
  }

  // Verify the transcript was captured deterministically.
  const stored = await mongodbMemory.store.sessionRecent(sessionId, 100)
  console.log(`\n📝 Session transcript stored: ${stored.length} turns`)
  for (const t of stored) {
    console.log(`  [${t.seq}] ${t.role}: ${t.content.slice(0, 80)}${t.content.length > 80 ? '…' : ''}`)
  }

  await mongodbMemory.close()
  console.log('\n✅ Connection closed.')
}

main().catch((err) => {
  console.error('Error:', err)
  process.exit(1)
})
