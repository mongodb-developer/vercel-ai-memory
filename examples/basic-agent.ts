/**
 * @example Basic Agent with MongoDB Memory
 *
 * This example shows how to use @mongodb-developer/vercel-ai-memory with the Vercel AI SDK
 * ToolLoopAgent to build a persistent-memory chatbot using a reusable agent pattern.
 *
 * The agent is created ONCE and reused across requests. userId and sessionId are
 * passed per-call via `callOptionsSchema` + `prepareCall`, making the agent fully
 * multi-tenant without re-instantiation.
 *
 * Prerequisites:
 *   - MongoDB Atlas cluster with vector search enabled (M10+)
 *   - npm install @ai-sdk/openai ai zod
 *   - MONGODB_URI environment variable set
 *   - OPENAI_API_KEY environment variable set
 *
 * Run:
 *   npx tsx examples/basic-agent.ts
 */

import { createMongoDBMemory } from '../src/index'
// NOTE: install @ai-sdk/openai before running: npm install @ai-sdk/openai
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { openai } = require('@ai-sdk/openai')
import { ToolLoopAgent, isLoopFinished } from 'ai'
import { z } from 'zod'

// ── 1. Create the memory instance ONCE at module level ────────────────────────
//
// MongoDB connects lazily on first tool use.
// Embedding dimensions are auto-detected on the first embed call.
//
const mongodbMemory = createMongoDBMemory({
  uri: process.env.MONGODB_URI ?? 'mongodb://localhost:27017',
  embedder: openai.embedding('text-embedding-3-small'),
  dbName: 'agent_memory_example',
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
  // prepareCall receives a single merged object containing both agent settings
  // and the per-call options (userId, sessionId).
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

  console.log('=== MongoDB Memory Agent Demo (Reusable Agent Pattern) ===\n')

  // Pre-warm the connection so indexes are ready before the first request
  await mongodbMemory.connect()
  console.log('✅ Connected to MongoDB Atlas\n')

  // Turn 1: Introduce yourself
  const prompt1 = 'Hi! My name is Alex and I really enjoy rock climbing and coffee.'
  console.log(`User: ${prompt1}`)
  const reply1 = await chat(userId, sessionId, prompt1)
  console.log(`Agent: ${reply1}\n`)

  // Turn 2: Ask about what the agent knows
  const prompt2 = 'What do you know about me so far?'
  console.log(`User: ${prompt2}`)
  const reply2 = await chat(userId, sessionId, prompt2)
  console.log(`Agent: ${reply2}\n`)

  // Turn 3: Record an event
  const prompt3 = 'I just completed my first lead climb today — a 5.10a route!'
  console.log(`User: ${prompt3}`)
  const reply3 = await chat(userId, sessionId, prompt3)
  console.log(`Agent: ${reply3}\n`)

  // Turn 4: Simulate a DIFFERENT user on the SAME agent instance (multi-tenant)
  const otherUserId = 'other-user'
  const otherSessionId = `session-${Date.now() + 1}`
  const prompt4 = 'Hello! My name is Jordan. I love cycling.'
  console.log(`\n--- Different user (${otherUserId}) on the same agent instance ---`)
  console.log(`User: ${prompt4}`)
  const reply4 = await chat(otherUserId, otherSessionId, prompt4)
  console.log(`Agent: ${reply4}\n`)

  // Turn 5: Return as Alex in a new session — agent recalls from semantic memory
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
  process.exit(1)
})
