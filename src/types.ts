import { ObjectId } from 'mongodb'

// ─────────────────────────────────────────────────────────────────────────────
//  SHARED EMBEDDED SHAPES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Lifecycle and scoring metadata — embedded in Semantic, Procedural, and Episodic memory.
 */
export interface UsageStats {
  /** Number of times this memory has been retrieved */
  retrieval_ct: number
  /** Rolling average importance score (1–10) */
  avg_importance: number
  /** Timestamp of last retrieval — used for TTL decay on EpisodicMemory */
  last_retrieved: Date
}

// ─────────────────────────────────────────────────────────────────────────────
//  COLLECTION 1 — Short-term (Session) Memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single turn in a conversation session.
 * TTL: auto-expire after 24h via index on `created_at`.
 */
export interface SessionMemory {
  _id: ObjectId
  /** Groups messages into one conversation */
  session_id: string
  /** Owning user / agent identity */
  user_id: string
  /** Turn order within session */
  seq: number
  /** "user" | "assistant" | "tool" */
  role: 'user' | 'assistant' | 'tool'
  /** Raw message text or tool output */
  content: string
  /** Populated when role = "tool" */
  tool_name?: string
  /** For context-window budgeting */
  token_count?: number
  /** TTL index drives expiry (86400s = 24h) */
  created_at: Date
  /**
   * Optional absolute expiry timestamp.
   * Powered by a `{ expire_at: 1 }` TTL index with `expireAfterSeconds: 0`,
   * so if set, Mongo expires the doc at exactly that moment.
   * Used by dynamic decay + agent-driven `memory_forget`.
   */
  expire_at?: Date | null
}

// ─────────────────────────────────────────────────────────────────────────────
//  COLLECTION 2 — Semantic Memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Long-term knowledge about people, entities, and user preferences.
 * Temporal versioning: new doc per update, old docs kept for history.
 * Vector search on `embedding` (cosine, dims auto-detected).
 */
export interface SemanticMemory {
  _id: ObjectId
  /** Subject / owner */
  user_id: string
  /** Entity name, e.g. "John Lin" */
  name: string
  /** Always "semantic" */
  category: 'semantic'
  /** Human-readable knowledge statement */
  description: string
  /** Vector for semantic retrieval */
  embedding: number[]
  /** LLM-assigned importance score (1–10) */
  importance: number
  /** Lifecycle & scoring metadata */
  stats: UsageStats
  /** Version timestamp (temporal versioning) */
  timestamp: Date
  /** true on the current version only */
  is_latest: boolean
  /** Optional facets for exact-match filtering */
  tags?: string[]
  /** Optional absolute expiry timestamp (dynamic decay / agent forget) */
  expire_at?: Date | null
}

// ─────────────────────────────────────────────────────────────────────────────
//  COLLECTION 3 — Procedural Memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How-to knowledge: tasks, workflows, agent instructions.
 * Temporal versioning same as SemanticMemory.
 */
export interface ProceduralMemory {
  _id: ObjectId
  /** Agent/user scope */
  user_id: string
  /** Short task label, e.g. "Browse Products" */
  task: string
  /** Always "procedural" */
  category: 'procedural'
  /** Step-by-step instructions */
  description: string
  /** Vector for semantic retrieval */
  embedding: number[]
  /** LLM-assigned importance score (1–10) */
  importance: number
  /** Lifecycle & scoring metadata */
  stats: UsageStats
  /** "human_expert" | "agent_learned" | "error_recovery" */
  source: 'human_expert' | 'agent_learned' | 'error_recovery'
  /** Version timestamp */
  timestamp: Date
  /** true on the current version only */
  is_latest: boolean
  /** Optional absolute expiry timestamp (dynamic decay / agent forget) */
  expire_at?: Date | null
}

// ─────────────────────────────────────────────────────────────────────────────
//  COLLECTION 4 — Episodic Memory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Records of key events, outcomes, and agent actions.
 * TTL: expire after 1yr based on `stats.last_retrieved`.
 */
export interface EpisodicMemory {
  _id: ObjectId
  user_id: string
  /** "rating" | "purchase" | "error" | "interaction" */
  event_type: string
  /** Always "episodic" */
  category: 'episodic'
  /** Narrative summary of the event */
  description: string
  /** Vector for semantic retrieval */
  embedding: number[]
  /** LLM-assigned importance score (1–10) */
  importance: number
  /** Lifecycle & scoring metadata; TTL uses last_retrieved */
  stats: UsageStats
  /** Free-form event-specific metadata */
  context?: Record<string, unknown>
  /** Event time */
  timestamp: Date
  /** Optional absolute expiry timestamp (dynamic decay / agent forget) */
  expire_at?: Date | null
}

// ─────────────────────────────────────────────────────────────────────────────
//  COLLECTION 5 — Scratchpad (Working / Temporary Notes)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Short-lived LLM scratch notes; periodically promoted to EpisodicMemory.
 * TTL: 1h on `created_at`.
 */
export interface ScratchpadMemory {
  _id: ObjectId
  session_id: string
  user_id: string
  /** Raw agent scratch text */
  note: string
  /** true once converted to episodic */
  promoted: boolean
  /** → EpisodicMemory._id when promoted */
  promoted_to_id?: ObjectId
  /** TTL: expire after 1h (3600s) */
  created_at: Date
  /** Optional absolute expiry timestamp (dynamic decay / agent forget) */
  expire_at?: Date | null
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION — USER-FACING OPTIONS
// ─────────────────────────────────────────────────────────────────────────────

import type { EmbeddingModel } from 'ai'

/** The five memory types supported by the package. */
export type MemoryType =
  | 'session'
  | 'semantic'
  | 'procedural'
  | 'episodic'
  | 'scratchpad'

/** The three memory types that have vector search indexes. */
export type VectorMemoryType = 'semantic' | 'procedural' | 'episodic'

/** Cosine is the default; Atlas also supports dotProduct and euclidean. */
export type VectorSimilarity = 'cosine' | 'dotProduct' | 'euclidean'

/**
 * Lightweight snapshot of a memory doc passed to `computeExpireAt`.
 * We keep this explicit so users can write a `computeExpireAt` without
 * depending on the full memory interfaces.
 */
export interface DecayInput {
  importance: number
  stats?: UsageStats
  createdAt: Date
}

/**
 * How a memory type decays over time.
 *
 * - `none`              : no automatic expiry (default for semantic/procedural).
 * - `ttl`               : classic Mongo TTL on a Date field.
 * - `ttl+importance`    : TTL index + partial filter `{ importance: { $lt: minImportance } }`,
 *                         so "important" docs are immune to decay.
 * - `dynamic`           : per-doc `expire_at` computed from `computeExpireAt`.
 *                         The package always maintains an `expireAfterSeconds: 0`
 *                         index on `expire_at`, so the doc expires exactly at that time.
 *                         If `refreshOnRead` is true (default), `expire_at` is
 *                         recomputed on every retrieval — implements a
 *                         forgetting-curve ("use it or lose it") policy.
 */
export type DecayPolicy =
  | { mode: 'none' }
  | {
      mode: 'ttl'
      ttlSeconds: number
      /** Field the TTL index watches. Default varies by memory type. */
      field?: string
    }
  | {
      mode: 'ttl+importance'
      ttlSeconds: number
      /** Docs with `importance < minImportance` are eligible for expiry. */
      minImportance: number
      /** Field the TTL index watches. Default varies by memory type. */
      field?: string
    }
  | {
      mode: 'dynamic'
      /**
       * Compute the absolute `expire_at` for a doc based on its importance,
       * usage stats, and creation time. Return `null` to never expire.
       */
      computeExpireAt: (input: DecayInput) => Date | null
      /**
       * If true, `expire_at` is recomputed on every retrieval.
       * Default: `true` (forgetting-curve behavior).
       */
      refreshOnRead?: boolean
    }

/**
 * Topology — where data lives and which memory types are active.
 */
export interface TopologyOptions {
  /** Database name. Default: `'agent_memory'` */
  dbName?: string
  /** Override collection names per memory type. */
  collections?: Partial<Record<MemoryType, string>>
  /** Override vector search index names. */
  vectorIndexNames?: Partial<Record<VectorMemoryType, string>>
  /**
   * Disable a memory type entirely — it will not be bootstrapped and its
   * tool commands will be removed from the tool schema.
   */
  disable?: MemoryType[]
  /**
   * Extra scalar filter fields to index in the vector search index for a
   * given memory type (e.g. `['tenant_id']` for multi-tenant setups).
   */
  extraFilterFields?: Partial<Record<VectorMemoryType, string[]>>
}

/**
 * Decay policies per memory type. Any omitted type uses the package default.
 */
export interface RetentionOptions {
  session?: DecayPolicy
  scratchpad?: DecayPolicy
  episodic?: DecayPolicy
  semantic?: DecayPolicy
  procedural?: DecayPolicy
}

/**
 * Retrieval-time filtering applied to vector search results.
 */
export interface FilteringOptions {
  /** Drop results with `importance < minImportance`. */
  minImportance?: number
  /** Only return memories accessed within this window. */
  recencyWindowHours?: number
  /** numCandidates = limit * numCandidatesMultiplier. Default: `10`. */
  numCandidatesMultiplier?: number
}

/**
 * Small default knobs.
 */
export interface DefaultsOptions {
  /** Default importance when not supplied by the agent. Default: `5`. */
  importance?: number
  /** Default limit for `session_recent`. Default: `40`. */
  sessionRecentLimit?: number
  /** Default limit for `*_search` commands. Default: `5`. */
  searchLimit?: number
  /** Vector similarity used when creating search indexes. Default: `'cosine'`. */
  similarity?: VectorSimilarity
}

/**
 * Options for `createMongoDBMemory()`.
 */
export interface MongoDBMemoryOptions {
  /** MongoDB Atlas connection string */
  uri: string
  /**
   * Any Vercel AI SDK EmbeddingModel (e.g. from @ai-sdk/openai, @ai-sdk/cohere, etc.).
   * Dimensions are auto-detected on first use via a probe embedding.
   * @example openai.embedding('text-embedding-3-small')
   * @example cohere.embedding('embed-english-v3.0')
   */
  embedder: EmbeddingModel
  /**
   * Database name. Default: `'agent_memory'`.
   * @deprecated Prefer `topology.dbName`. Kept for backward compatibility.
   */
  dbName?: string
  /**
   * Default userId scoping when not provided at call time.
   * Can be overridden per-call: `mongodbMemory({ userId, sessionId })`
   */
  userId?: string
  /**
   * Default sessionId scoping when not provided at call time.
   * Can be overridden per-call: `mongodbMemory({ userId, sessionId })`
   */
  sessionId?: string

  /** Where data lives (db, collections, index names, disabled types). */
  topology?: TopologyOptions
  /** How each memory type decays. */
  retention?: RetentionOptions
  /** Retrieval-time filters applied to vector search. */
  filtering?: FilteringOptions
  /** Small default values (importance, limits, similarity). */
  defaults?: DefaultsOptions
}

/**
 * Per-call scoping options passed to the callable memory instance.
 */
export interface MemoryCallOptions {
  /** User identifier — scopes all memory operations to this user */
  userId?: string
  /** Session identifier — scopes session & scratchpad operations */
  sessionId?: string
}

// ─────────────────────────────────────────────────────────────────────────────
//  CONFIGURATION — RESOLVED (INTERNAL) SHAPE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fully-resolved configuration with all defaults applied.
 * Produced by `resolveConfig()` and consumed by the store and tool.
 */
export interface MemoryConfig {
  dbName: string
  defaultUserId: string
  defaultSessionId: string

  collections: Record<MemoryType, string>
  vectorIndexNames: Record<VectorMemoryType, string>
  disabled: Set<MemoryType>
  extraFilterFields: Record<VectorMemoryType, string[]>

  retention: Required<{
    session: DecayPolicy
    scratchpad: DecayPolicy
    episodic: DecayPolicy
    semantic: DecayPolicy
    procedural: DecayPolicy
  }>

  filtering: Required<FilteringOptions>
  defaults: Required<DefaultsOptions>
}
