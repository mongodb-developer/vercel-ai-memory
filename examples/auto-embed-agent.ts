/**
 * @example Basic Agent with MongoDB Memory — Atlas Automated Embedding (Voyage AI)
 *
 * This is the auto-embedding twin of `basic-agent.ts`. Instead of passing a
 * client-side `embedder`, it opts into **Atlas Automated Embedding** by passing
 * `autoEmbed: { model: 'voyage-4' }`. In this mode MongoDB Atlas generates and
 * manages the embeddings server-side (Voyage AI) — there is no client embedding
 * pipeline. The store persists the source text in an `embed_text` field and
 * runs `$vectorSearch` with a `query` string.
 *
 * Everything else — the reusable multi-tenant agent, per-call userId/sessionId
 * scoping, and the memory tool commands — is identical to `basic-agent.ts`.
 *
 * Prerequisites:
 *   - MongoDB Atlas cluster with Vector Search AND **Voyage AI / Automated
 *     Embedding enabled for your organization** (Preview feature). On dedicated
 *     (M10+) clusters, enable storage auto-scaling.
 *   - npm install @ai-sdk/openai ai zod
 *   - MONGODB_URI environment variable set (local: .env.local; production:
 *     store it as a Vercel Secret — see README "Connection string & secrets")
 *   - OPENAI_API_KEY environment variable set (chat model only — the conversation
 *     uses OpenAI; embeddings are generated server-side by Atlas/Voyage AI)
 *   - Optional: VOYAGE_MODEL to override the embedding model (defaults to 'voyage-4')
 *
 * Run:
 *   npx tsx examples/auto-embed-agent.ts
 */

import { createMongoDBMemory } from '../src/index'
// NOTE: install @ai-sdk/openai before running: npm install @ai-sdk/openai
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openai } = require('@ai-sdk/openai')
import { ToolLoopAgent, isLoopFinished } from 'ai'
import { z } from 'zod'

// ── 1. Create the memory instance ONCE at module level ────────────────────────
//
// MongoDB connects lazily on first tool use. In auto-embed mode Atlas owns the
// embedding dimensions and model — no client embedder is constructed, so the
// OpenAI chat model below is used ONLY for the conversation, never for embeddings.
//
const VOYAGE_MODEL = process.env.VOYAGE_MODEL ?? 'voyage-4'

const mongodbMemory = createMongoDBMemory({
  uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
  // 👇 The only difference from basic-agent.ts: opt into Atlas Automated Embedding.
  //    Provide EXACTLY ONE of `embedder` (client-side) or `autoEmbed` (server-side).
  autoEmbed: { model: VOYAGE_MODEL },
  dbName: 'agent_memory_autoembed_example',
})

// ── 2. Create a REUSABLE agent ────────────────────────────────────────────────
//
// userId and sessionId are NOT baked in — they are passed at generate() time
// via `options`, keeping this agent instance reusable across all users/sessions.
//
const agent = new ToolLoopAgent({
  model: openai('gpt-4o-mini'),

  // Declare the shape of per-call options (typed via Zod)
  callOptionsSchema: z.object({
    userId: z.string(),
    sessionId: z.string(),
  }),

  // Inject memory tools scoped to this specific user + session at call time.
  prepareCall: async ({ options, ...settings }) => ({
    ...settings,
    tools: mongodbMemory({ userId: options?.userId, sessionId: options?.sessionId }),
    instructions: `You are a helpful assistant with persistent long-term memory.

At the start of every session:
1. Call session_recent to restore conversation context.
2. If the user refers to past events or preferences, call semantic_search or episodic_search.

When you learn something important about the user:
- Personal facts (name, preferences, interests) → semantic_save
- Events and outcomes → episodic_save
- How-to knowledge → procedural_save

Never mention the memory system to the user. Respond naturally.`,
  }),

  stopWhen: isLoopFinished(),
})

// ── 3. Simulate a multi-turn conversation ─────────────────────────────────────

async function chat(userId: string, sessionId: string, prompt: string): Promise<string> {
  const result = await agent.generate({
    prompt,
    options: { userId, sessionId },  // scoped per-call — agent is reused
  })
  return result.text
}

// ── 4. Run the demo ───────────────────────────────────────────────────────────

async function main() {
  const userId = 'demo-user'
  const sessionId = `session-${Date.now()}`

  console.log('=== MongoDB Memory Agent Demo — Atlas Automated Embedding (Voyage AI) ===\n')
  console.log(`Embedding model (server-side): ${VOYAGE_MODEL}\n`)

  // Pre-warm the connection. This bootstraps `type:"autoEmbed"` vector indexes.
  // Atlas builds indexes and generates embeddings ASYNCHRONOUSLY, so the first
  // *_search right after a *_save may need a moment to become searchable.
  await mongodbMemory.connect()
  console.log('✅ Connected to MongoDB Atlas (auto-embed indexes bootstrapped)\n')

  // Turn 1: Introduce yourself → agent should semantic_save your preferences.
  const prompt1 = 'Hi! My name is Alex and I really enjoy rock climbing and coffee.'
  console.log(`User: ${prompt1}`)
  const reply1 = await chat(userId, sessionId, prompt1)
  console.log(`Agent: ${reply1}\n`)

  // Turn 2: Ask about what the agent knows (in-session recall).
  // NOTE: recall here is LLM-DRIVEN — the model must choose to call
  // semantic_search / session_recent, and Atlas embeds asynchronously, so a fact
  // saved seconds ago may not be searchable yet. If the reply says it knows
  // nothing, that is the model declining to search, NOT a retrieval failure —
  // the data is stored and scoped correctly (see tests/integration/auto-embed.test.ts,
  // which forces scoped searches and asserts the right doc comes back). For
  // guaranteed history injection on every turn, use the `loadSession` pattern in
  // examples/deterministic-agent.ts.
  const prompt2 = 'What do you know about me so far?'
  console.log(`User: ${prompt2}`)
  const reply2 = await chat(userId, sessionId, prompt2)
  console.log(`Agent: ${reply2}\n`)

  // Turn 3: Record an event → agent should episodic_save it.
  const prompt3 = 'I just completed my first lead climb today — a 5.10a route!'
  console.log(`User: ${prompt3}`)
  const reply3 = await chat(userId, sessionId, prompt3)
  console.log(`Agent: ${reply3}\n`)

  // Turn 4: A DIFFERENT user on the SAME agent instance (multi-tenant).
  const otherUserId = 'other-user'
  const otherSessionId = `session-${Date.now() + 1}`
  const prompt4 = 'Hello! My name is Jordan. I love cycling.'
  console.log(`\n--- Different user (${otherUserId}) on the same agent instance ---`)
  console.log(`User: ${prompt4}`)
  const reply4 = await chat(otherUserId, otherSessionId, prompt4)
  console.log(`Agent: ${reply4}\n`)

  // Turn 5: Return as Alex in a NEW session — recall via server-side vector search.
  // (Auto-embeddings are generated async; if recall seems empty on the very first
  //  run, wait a few seconds and re-run — the embeddings will have materialized.)
  const newSessionId = `session-${Date.now() + 2}`
  const prompt5 = "Hey, it's me again. Do you remember what I told you about climbing?"
  console.log(`\n--- Alex returns in a new session (${newSessionId}) ---`)
  console.log(`User: ${prompt5}`)
  const reply5 = await chat(userId, newSessionId, prompt5)
  console.log(`Agent: ${reply5}\n`)

  // Cleanup
  await mongodbMemory.close()
  console.log('✅ Connection closed.')
}

main().catch((err) => {
  console.error('Error:', err)
  console.error(
    '\nIf you see "Failed to create vector index ..." above, Atlas Automated ' +
      'Embedding (Voyage AI) is likely not enabled for your organization. ' +
      'Enable it (Preview) and try again, or use examples/basic-agent.ts ' +
      '(client-side embeddings) instead.'
  )
  process.exit(1)
})

