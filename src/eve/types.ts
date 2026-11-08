import type { EmbeddingModel, LanguageModel } from 'ai'
import type {
  AutoEmbedOptions,
  DecayPolicy,
  RetentionOptions,
} from '../types'

/**
 * Which memory tiers the Eve provider should use.
 *
 * Session and scratchpad tiers are intentionally NOT exposed here: Eve owns the
 * session/runtime lifecycle, so the adapter always disables them and relies on
 * durable semantic / episodic / procedural memory instead.
 */
export interface EveMemoryTiers {
  /** Long-term facts & preferences (versioned). Default: `true`. */
  semantic?: boolean
  /** Events, outcomes, interactions. Default: `true`. */
  episodic?: boolean
  /** How-to knowledge and workflows (versioned). Default: `true`. */
  procedural?: boolean
}

/** Retrieval tuning applied to every recall. */
export interface EveRecallOptions {
  /**
   * Max results **per tier** returned to the model on recall. Maps to the
   * store's `defaults.searchLimit`. Default: `5`.
   */
  limit?: number
  /**
   * Optional minimum vector-search similarity (0–1). Recalled memories whose
   * score is below this are dropped. Best-effort: only applied when the store
   * surfaces a score. Default: `0` (no threshold).
   */
  minSimilarity?: number
}

/**
 * Capture mode — how new durable memories are created.
 *
 * - `"automatic"` (**default**, matching the Supermemory / Upstash AgentKit
 *   convention): after each turn the provider extracts and classifies durable
 *   memories and writes them. Full LLM classification needs a `captureModel`
 *   (or a model surfaced by Eve on the capture context); without one the
 *   provider falls back to a lightweight heuristic and logs a one-time note.
 * - `"agent"`: the model decides via the `remember` / `forget` tools.
 * - `false`: recall only; no automatic capture (tools still available).
 */
export type EveCaptureMode = 'automatic' | 'agent' | false

/**
 * Options for {@link mongodbMemory} — the MongoDB provider for Vercel Eve.
 *
 * The easy path is tiny:
 * ```ts
 * mongodbMemory({ uri: process.env.MONGODB_URI!, embedder })
 * // or, with Atlas Automated Embedding (no client embedder):
 * mongodbMemory({ uri: process.env.MONGODB_URI!, autoEmbed: { model: 'voyage-3-large' } })
 * ```
 */
export interface EveMongoMemoryOptions {
  /** MongoDB Atlas connection string. */
  uri: string
  /**
   * Any Vercel AI SDK EmbeddingModel. Provide exactly one of `embedder` /
   * `autoEmbed`.
   */
  embedder?: EmbeddingModel
  /**
   * Opt-in Atlas Automated Embedding (Voyage AI, server-side). Provide exactly
   * one of `embedder` / `autoEmbed`.
   */
  autoEmbed?: AutoEmbedOptions
  /**
   * Opt-in: drop & recreate a vector index whose type mismatches the embedding
   * mode. Default `false` — bootstrap throws instead. See the README section
   * "Switching embedding modes".
   */
  recreateMismatchedIndex?: boolean

  /**
   * Database name. Default: `'agent_memory'`.
   */
  dbName?: string

  /** Capture mode. Default: `"automatic"`. */
  capture?: EveCaptureMode
  /**
   * Language model used by `capture: "automatic"` to extract & classify durable
   * memories. Optional — see {@link EveCaptureMode}.
   */
  captureModel?: LanguageModel

  /** Which durable memory tiers to enable. Defaults: all `true`. */
  memory?: EveMemoryTiers

  /** Retrieval tuning applied to every recall. */
  recall?: EveRecallOptions

  /**
   * Retention / decay policies per durable tier. Mapped directly onto the
   * package's existing retention configuration.
   */
  retention?: Pick<RetentionOptions, 'semantic' | 'episodic' | 'procedural'>
}

export type { DecayPolicy }
