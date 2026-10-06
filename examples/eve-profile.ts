// agent/memory/profile.ts
//
// Vercel Eve memory slot backed by MongoDB Atlas.
//
// This is the entire integration — define a scope and a provider, and MongoDB
// gives your Eve agent production-grade, cross-session long-term memory:
//   - automatic relevant recall before each turn
//   - automatic capture of durable memories after each turn
//   - semantic / episodic / procedural tiers
//   - Atlas Vector Search, retention, and forgetting
//
// Every read/write is partitioned by Eve's trusted principal scope — the model
// never chooses the memory owner.
//
// MONGODB_URI: in production, store it as a Vercel Secret in the deployment
// environment (never in source or compiled artifacts). Locally, `eve link` /
// `vercel env pull .env.local`. See README "Connection string & secrets".

import { defineMemory } from 'eve/memory'
import { byPrincipal } from 'eve/memory/scope'
import { mongodbMemory } from '@mongodb-developer/vercel-ai-memory/eve'

// Your embedding model (any Vercel AI SDK EmbeddingModel), e.g.:
//   import { openai } from '@ai-sdk/openai'
//   const embedder = openai.embedding('text-embedding-3-small')
declare const embedder: import('ai').EmbeddingModel

export default defineMemory({
  description: 'Durable facts, preferences, history, and procedures per caller.',
  scope: byPrincipal,
  provider: mongodbMemory({
    uri: process.env.MONGODB_URI!,
    embedder,
    capture: 'automatic',
  }),
})

// ─── Alternative: Atlas Automated Embedding (no client embedder) ──────────────
// MongoDB Atlas generates and manages embeddings server-side (Voyage AI):
//
//   provider: mongodbMemory({
//     uri: process.env.MONGODB_URI!,
//     autoEmbed: { model: 'voyage-3-large' },
//   })
//
// ─── Alternative: agent-driven capture + advanced tuning ─────────────────────
//
//   provider: mongodbMemory({
//     uri: process.env.MONGODB_URI!,
//     embedder,
//     capture: 'agent',                 // model calls profile__remember / profile__forget
//     memory: { semantic: true, episodic: true, procedural: true },
//     recall: { limit: 8, minSimilarity: 0.72 },
//     retention: { episodic: { mode: 'ttl', ttlSeconds: 60 * 60 * 24 * 90 } },
//   })
