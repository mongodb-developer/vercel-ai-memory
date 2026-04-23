# `@mongodb-developer/vercel-ai-memory`

MongoDB-backed persistent memory for the [Vercel AI SDK](https://sdk.vercel.ai). Gives your agent five structured memory tiers — **Session**, **Semantic**, **Procedural**, **Episodic**, and **Scratchpad** — all stored in MongoDB Atlas with automatic vector search indexes and per-type retention policies.

## Features

- 🧠 **5 memory types** — session history, entity knowledge, how-to procedures, event episodes, and a temporary scratchpad
- 🔍 **Atlas Vector Search** — semantic retrieval powered by any Vercel AI SDK embedding model
- 📏 **Auto-detected dimensions** — no need to configure vector dimensions; the package probes them at startup
- ⏱️ **Flexible retention** — per-type policies: `none`, `ttl`, `ttl+importance`, or fully `dynamic` (forgetting curve)
- 🗑️ **Agent-driven `memory_forget`** — let the model mark individual memories for immediate deletion
- 🧩 **Multi-tenant ready** — custom collection/index names, extra filter fields (e.g. `tenant_id`), or disable types entirely
- 🔄 **Temporal versioning** — semantic and procedural memories are versioned; history is preserved
- 🏗️ **Zero lock-in** — works with any AI SDK model and any embedding provider (VoyageAI, OpenAI, Cohere, Google, etc.)
- 🔌 **Lazy connection** — MongoDB connects on first tool use; call `.connect()` early if you prefer

## Installation

```bash
npm install @mongodb-developer/vercel-ai-memory
# or
pnpm add @mongodb-developer/vercel-ai-memory
```

**Peer dependencies** (install separately):

```bash
npm install ai mongodb zod
```

## Quick Start

```ts
import { createMongoDBMemory } from '@mongodb-developer/vercel-ai-memory'
import { openai } from '@ai-sdk/openai'
import { ToolLoopAgent } from 'ai'

// ── 1. Create the memory instance (once, at module/server level) ──────────────
const mongodbMemory = createMongoDBMemory({
  uri: process.env.MONGODB_URI!,
  embedder: openai.embedding('text-embedding-3-small'),
})

// ── 2. Use per-request, scoped to a user and session ─────────────────────────
const agent = new ToolLoopAgent({
  model: openai('gpt-4.1'),
  tools: mongodbMemory({ userId: 'alice', sessionId: 'sess-001' }),
})

const result = await agent.generate({
  prompt: 'My name is Alice and I love hiking. Remember that.',
})
```

`mongodbMemory({ userId, sessionId })` returns the tools record directly — no spreading needed.

## Configuration

All options are passed to `createMongoDBMemory(options)`.

### Top-level

| Option | Type | Required | Default | Description |
|--------|------|----------|---------|-------------|
| `uri` | `string` | ✅ | — | MongoDB Atlas connection string |
| `embedder` | `EmbeddingModel` | ✅ | — | Any Vercel AI SDK embedding model |
| `userId` | `string` | — | `'default'` | Default userId (override per-call) |
| `sessionId` | `string` | — | `'default'` | Default sessionId (override per-call) |
| `dbName` | `string` | — | `'agent_memory'` | Database name. *(Deprecated — prefer `topology.dbName`.)* |
| `topology` | `TopologyOptions` | — | `{}` | Where data lives — db, collections, indexes, disabled types |
| `retention` | `RetentionOptions` | — | see below | Per-type decay / TTL policies |
| `filtering` | `FilteringOptions` | — | see below | Retrieval-time filters on vector search results |
| `defaults` | `DefaultsOptions` | — | see below | Small defaults (importance, limits, similarity) |

### `topology` — data location & layout

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `topology.dbName` | `string` | `'agent_memory'` | Database name (takes precedence over the legacy top-level `dbName`) |
| `topology.collections` | `Partial<Record<MemoryType, string>>` | see **Collection defaults** below | Override collection names per memory type |
| `topology.vectorIndexNames` | `Partial<Record<VectorMemoryType, string>>` | see **Index defaults** below | Override Atlas Vector Search index names |
| `topology.disable` | `MemoryType[]` | `[]` | Disable memory types entirely — no bootstrap, commands removed from tool schema |
| `topology.extraFilterFields` | `Partial<Record<VectorMemoryType, string[]>>` | `{}` | Extra scalar fields to index as Atlas Search filters (e.g. `['tenant_id']`) |

**Collection defaults:**

| Memory type | Default collection name |
|---|---|
| `session` | `session_memory` |
| `semantic` | `semantic_memory` |
| `procedural` | `procedural_memory` |
| `episodic` | `episodic_memory` |
| `scratchpad` | `scratchpad_memory` |

**Index defaults:**

| Memory type | Default vector index name |
|---|---|
| `semantic` | `semantic_vector_index` |
| `procedural` | `procedural_vector_index` |
| `episodic` | `episodic_vector_index` |

### `retention` — how each memory type decays

Every memory type accepts a `DecayPolicy`, one of four modes:

| Mode | Shape | What it does |
|------|-------|--------------|
| `none` | `{ mode: 'none' }` | Memories never auto-expire. |
| `ttl` | `{ mode: 'ttl', ttlSeconds, field? }` | Classic Mongo TTL index on a `Date` field. |
| `ttl+importance` | `{ mode: 'ttl+importance', ttlSeconds, minImportance, field? }` | TTL only applies to docs with `importance < minImportance` — important memories are immune. |
| `dynamic` | `{ mode: 'dynamic', computeExpireAt, refreshOnRead? }` | Per-doc `expire_at` computed on write (and recomputed on read when `refreshOnRead: true`, default). Backed by an `expireAfterSeconds: 0` TTL index — perfect for **forgetting-curve** semantics. |

**`computeExpireAt(input)`** receives `{ importance, stats, createdAt }` and returns a `Date` (or `null` to never expire).

**Default retention policies:**

| Memory type | Default policy |
|---|---|
| `session` | `{ mode: 'ttl', ttlSeconds: 86_400 }` — 24 h on `created_at` |
| `scratchpad` | `{ mode: 'ttl', ttlSeconds: 3_600 }` — 1 h on `created_at` |
| `episodic` | `{ mode: 'ttl', ttlSeconds: 31_536_000, field: 'stats.last_retrieved' }` — 1 yr of inactivity |
| `semantic` | `{ mode: 'none' }` |
| `procedural` | `{ mode: 'none' }` |

**Examples:**

```ts
retention: {
  // Keep only important semantic facts after a week
  semantic: { mode: 'ttl+importance', ttlSeconds: 604_800, minImportance: 7 },

  // Forgetting curve — important episodes live longer, rarely-read ones decay fast
  episodic: {
    mode: 'dynamic',
    refreshOnRead: true,
    computeExpireAt: ({ importance, stats, createdAt }) => {
      const hoursFromNow = Math.pow(2, importance) // 2^importance hours
      return new Date(Date.now() + hoursFromNow * 3600 * 1000)
    },
  },

  // Disable session auto-expiry entirely
  session: { mode: 'none' },
}
```

### `filtering` — retrieval-time filters

Applied to every `*_search` vector query.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `filtering.minImportance` | `number` (1–10) | `0` | Drop results with `importance < minImportance` |
| `filtering.recencyWindowHours` | `number` | `0` (disabled) | Only return memories retrieved within the last N hours |
| `filtering.numCandidatesMultiplier` | `number` | `10` | `$vectorSearch.numCandidates = limit * multiplier`. Higher → better recall, slower query. |

### `defaults` — small knobs

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaults.importance` | `number` (1–10) | `5` | Default importance when the agent doesn't supply one |
| `defaults.sessionRecentLimit` | `number` | `40` | Default `limit` for `session_recent` |
| `defaults.searchLimit` | `number` | `5` | Default `limit` for all `*_search` commands |
| `defaults.similarity` | `'cosine' \| 'dotProduct' \| 'euclidean'` | `'cosine'` | Vector similarity used when creating Atlas Search indexes |

## Configuration Recipes

### Minimal — just point it at Mongo

```ts
createMongoDBMemory({
  uri: process.env.MONGODB_URI!,
  embedder: openai.embedding('text-embedding-3-small'),
})
```

### Multi-tenant — add a `tenant_id` filter field

```ts
createMongoDBMemory({
  uri: process.env.MONGODB_URI!,
  embedder: openai.embedding('text-embedding-3-small'),
  topology: {
    extraFilterFields: {
      semantic: ['tenant_id'],
      procedural: ['tenant_id'],
      episodic: ['tenant_id'],
    },
  },
})
```

### Session-only — disable everything else

```ts
createMongoDBMemory({
  uri: process.env.MONGODB_URI!,
  embedder: openai.embedding('text-embedding-3-small'),
  topology: {
    disable: ['semantic', 'procedural', 'episodic', 'scratchpad'],
  },
})
```

### Custom collection names (existing schema)

```ts
createMongoDBMemory({
  uri: process.env.MONGODB_URI!,
  embedder: openai.embedding('text-embedding-3-small'),
  topology: {
    dbName: 'my_app',
    collections: {
      session: 'agent_sessions',
      semantic: 'agent_facts',
    },
    vectorIndexNames: {
      semantic: 'agent_facts_vs',
    },
  },
})
```

### Aggressive cleanup — keep only high-value semantic facts

```ts
createMongoDBMemory({
  uri: process.env.MONGODB_URI!,
  embedder: openai.embedding('text-embedding-3-small'),
  retention: {
    semantic: { mode: 'ttl+importance', ttlSeconds: 30 * 86_400, minImportance: 6 },
  },
  filtering: {
    minImportance: 3,        // never surface low-importance memories
    recencyWindowHours: 24 * 30, // only last 30 days of reads
  },
})
```

### Forgetting curve — dynamic decay

```ts
createMongoDBMemory({
  uri: process.env.MONGODB_URI!,
  embedder: openai.embedding('text-embedding-3-small'),
  retention: {
    episodic: {
      mode: 'dynamic',
      refreshOnRead: true,
      computeExpireAt: ({ importance, stats }) => {
        // Half-life grows with importance and retrieval count
        const baseHours = 24 * Math.pow(1.5, importance)
        const boost = (stats?.retrieval_ct ?? 0) * 12
        return new Date(Date.now() + (baseHours + boost) * 3600 * 1000)
      },
    },
  },
})
```

### Tune recall vs. latency

```ts
filtering: {
  numCandidatesMultiplier: 25, // higher recall, slower
}
```

## Supported Embedding Providers

Any model that implements the Vercel AI SDK `EmbeddingModel` interface. Dimensions are **auto-detected**.

```ts
import { openai } from '@ai-sdk/openai'
import { cohere } from '@ai-sdk/cohere'
import { google } from '@ai-sdk/google'

embedder: openai.embedding('text-embedding-3-small')        // 1536
embedder: cohere.embedding('embed-english-v3.0')            // 1024
embedder: google.textEmbeddingModel('text-embedding-004')   // 768
```

## API

### `createMongoDBMemory(options)`

Creates a MongoDB memory provider. Returns a callable `MongoDBMemoryInstance`.

### `mongodbMemory(callOptions?)`

Callable — returns a `{ memory: Tool }` record scoped to the given `userId` and `sessionId`.

```ts
tools: mongodbMemory({ userId: req.userId, sessionId: req.sessionId })
tools: mongodbMemory() // use defaults set at creation time
```

### `mongodbMemory.connect()`

Explicitly connect and bootstrap indexes. Called automatically on first tool use.

```ts
await mongodbMemory.connect() // pre-warm on server startup
```

### `mongodbMemory.close()`

Gracefully close the MongoDB connection.

```ts
process.on('SIGTERM', () => mongodbMemory.close())
```

### `mongodbMemory.store`

Raw `MongoMemoryStore` for advanced direct access:

```ts
await mongodbMemory.store.semanticSave('alice', 'Preference', 'Loves hiking', { importance: 8 })
const results = await mongodbMemory.store.semanticSearch('alice', 'outdoor activities')
await mongodbMemory.store.forget('semantic', someMemoryId) // immediate agent-driven delete
```

## Memory Types & Tool Commands

The single `memory` tool accepts a `command` field and routes to the right memory type.

### Session Memory
Per-session conversation turns.
```
session_append {role, content}  — Save a turn
session_recent {limit?}         — Get last N turns (default: defaults.sessionRecentLimit)
```

### Semantic Memory
Long-term knowledge about people, entities, and user preferences. **Temporally versioned**.
```
semantic_save {name, content, importance?, tags?}  — Save/update entity knowledge
semantic_search {query, limit?}                    — Vector search
```

### Procedural Memory
How-to knowledge: tasks, workflows, agent instructions. **Temporally versioned**.
```
procedural_save {task, content, importance?, source?}  — Save/update a procedure
procedural_search {query, limit?}                      — Vector search
```

### Episodic Memory
Records of key events and outcomes.
```
episodic_save {event_type, content, importance?, context?}  — Record an event
episodic_search {query, limit?}                             — Vector search
```

### Scratchpad Memory
Temporary working notes. Can be promoted to Episodic memory.
```
scratchpad_write {content}                         — Write a temporary note
scratchpad_read                                    — Read current session notes
scratchpad_promote {scratchpad_id, event_type}     — Promote note → Episodic
```

### `memory_forget` — agent-driven deletion

Always available; lets the LLM explicitly forget a specific memory (e.g. when the user says "forget that").

```
memory_forget {memory_type, id, reason?}
```

Internally sets `expire_at` to "now", leveraging the `expire_at` TTL index. The doc is removed on the next TTL sweep (usually within ~60 s).

> **Disabled types** are removed from the tool's command enum *and* skipped during bootstrap, so the agent can't attempt to use them.

## MongoDB Collections & Indexes

With defaults, the package creates:

| Collection | Retention | Vector Index |
|---|---|---|
| `session_memory` | 24 h on `created_at` | — |
| `semantic_memory` | none | ✅ cosine (auto-dims) |
| `procedural_memory` | none | ✅ cosine (auto-dims) |
| `episodic_memory` | 1 yr on `stats.last_retrieved` | ✅ cosine (auto-dims) |
| `scratchpad_memory` | 1 h on `created_at` | — |

All collections also get an `expire_at` TTL index (`expireAfterSeconds: 0`) to power `memory_forget` and `dynamic` retention.

> **Note**: Atlas Vector Search indexes are created asynchronously. Allow a few seconds for them to build on a fresh database.

## Usage in Next.js (App Router)

```ts
// app/api/chat/route.ts
import { createMongoDBMemory } from '@mongodb-developer/vercel-ai-memory'
import { openai } from '@ai-sdk/openai'
import { ToolLoopAgent, createAgentUIStreamResponse } from 'ai'

const mongodbMemory = createMongoDBMemory({
  uri: process.env.MONGODB_URI!,
  embedder: openai.embedding('text-embedding-3-small'),
})

export async function POST(req: Request) {
  const { messages, userId, sessionId } = await req.json()

  const agent = new ToolLoopAgent({
    model: openai('gpt-4.1'),
    tools: mongodbMemory({ userId, sessionId }),
    instructions: `You are a helpful assistant with persistent memory.
    At the start of each session, call session_recent to restore context.
    Save important facts with semantic_save. If the user asks you to forget
    something, call memory_forget with the matching memory_type + id.`,
  })

  return createAgentUIStreamResponse({ agent, uiMessages: messages })
}
```

## Advanced: Direct Store Access

```ts
const { store } = mongodbMemory

// Seed procedural knowledge
await store.proceduralSave(
  'system',
  'Onboarding Flow',
  '1. Greet user by name. 2. Ask about their goals. 3. Set up preferences.',
  { source: 'human_expert', importance: 9 }
)

// Promote a scratchpad note to episodic memory
const scratchId = await store.scratchpadWrite('alice', 'sess-001', 'User mentioned they dislike emails')
await store.scratchpadPromote(scratchId.toString(), 'alice', 'preference', { importance: 7 })

// Immediately forget a memory
await store.forget('semantic', '507f1f77bcf86cd799439011')
```

## Environment Variables

```bash
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/?retryWrites=true&w=majority
OPENAI_API_KEY=sk-...   # or whichever embedding provider you use
```

## License

Apache 2.0 — see [LICENSE](./LICENSE)
