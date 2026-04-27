import type {
  MemoryConfig,
  MemoryType,
  MongoDBMemoryOptions,
  VectorMemoryType,
} from './types'

// ─── Package-wide defaults (mirror the original hardcoded behavior) ───────────

const DEFAULT_DB_NAME = 'agent_memory'

const DEFAULT_COLLECTIONS: Record<MemoryType, string> = {
  session: 'session_memory',
  semantic: 'semantic_memory',
  procedural: 'procedural_memory',
  episodic: 'episodic_memory',
  scratchpad: 'scratchpad_memory',
}

const DEFAULT_VECTOR_INDEX_NAMES: Record<VectorMemoryType, string> = {
  semantic: 'semantic_vector_index',
  procedural: 'procedural_vector_index',
  episodic: 'episodic_vector_index',
}

/**
 * Default decay policies — match the original hardcoded behavior:
 *   - session    : 24h TTL on created_at
 *   - scratchpad : 1h TTL on created_at
 *   - episodic   : 1yr TTL on stats.last_retrieved
 *   - semantic   : none (versioned, keep history)
 *   - procedural : none (versioned, keep history)
 */
const DEFAULT_RETENTION: MemoryConfig['retention'] = {
  session: { mode: 'ttl', ttlSeconds: 86_400, field: 'created_at' },
  scratchpad: { mode: 'ttl', ttlSeconds: 3_600, field: 'created_at' },
  episodic: {
    mode: 'ttl',
    ttlSeconds: 31_536_000,
    field: 'stats.last_retrieved',
  },
  semantic: { mode: 'none' },
  procedural: { mode: 'none' },
}

const DEFAULT_FILTERING: Required<MemoryConfig['filtering']> = {
  minImportance: 0,
  recencyWindowHours: 0, // 0 = no recency filter
  numCandidatesMultiplier: 10,
}

const DEFAULT_DEFAULTS: Required<MemoryConfig['defaults']> = {
  importance: 5,
  sessionRecentLimit: 40,
  searchLimit: 5,
  similarity: 'cosine',
}

// ─── Resolver ─────────────────────────────────────────────────────────────────

/**
 * Resolve user-supplied options into a fully-populated `MemoryConfig`.
 *
 * This is the single source of truth for defaults — the store and tool both
 * consume a `MemoryConfig`. Calling with an empty options object (other than
 * the two required fields) reproduces the original hardcoded behavior exactly.
 */
export function resolveConfig(options: MongoDBMemoryOptions): MemoryConfig {
  if (!options.uri) throw new Error('[mongodb-memory] `uri` is required')
  if (!options.embedder) throw new Error('[mongodb-memory] `embedder` is required')

  // dbName precedence: topology.dbName > legacy dbName > default
  const dbName =
    options.topology?.dbName ?? options.dbName ?? DEFAULT_DB_NAME

  const collections: Record<MemoryType, string> = {
    ...DEFAULT_COLLECTIONS,
    ...(options.topology?.collections ?? {}),
  }

  const vectorIndexNames: Record<VectorMemoryType, string> = {
    ...DEFAULT_VECTOR_INDEX_NAMES,
    ...(options.topology?.vectorIndexNames ?? {}),
  }

  const disabled = new Set<MemoryType>(options.topology?.disable ?? [])
  // hiddenFromTool is always a superset of disabled — a fully disabled type
  // is of course also absent from the tool schema.
  const hiddenFromTool = new Set<MemoryType>([
    ...disabled,
    ...(options.topology?.hideToolCommands ?? []),
  ])

  const extraFilterFields: Record<VectorMemoryType, string[]> = {
    semantic: options.topology?.extraFilterFields?.semantic ?? [],
    procedural: options.topology?.extraFilterFields?.procedural ?? [],
    episodic: options.topology?.extraFilterFields?.episodic ?? [],
  }

  const retention: MemoryConfig['retention'] = {
    session: options.retention?.session ?? DEFAULT_RETENTION.session,
    scratchpad: options.retention?.scratchpad ?? DEFAULT_RETENTION.scratchpad,
    episodic: options.retention?.episodic ?? DEFAULT_RETENTION.episodic,
    semantic: options.retention?.semantic ?? DEFAULT_RETENTION.semantic,
    procedural: options.retention?.procedural ?? DEFAULT_RETENTION.procedural,
  }

  validateRetention(retention)

  const filtering: Required<MemoryConfig['filtering']> = {
    minImportance:
      options.filtering?.minImportance ?? DEFAULT_FILTERING.minImportance,
    recencyWindowHours:
      options.filtering?.recencyWindowHours ??
      DEFAULT_FILTERING.recencyWindowHours,
    numCandidatesMultiplier:
      options.filtering?.numCandidatesMultiplier ??
      DEFAULT_FILTERING.numCandidatesMultiplier,
  }

  const defaults: Required<MemoryConfig['defaults']> = {
    importance: options.defaults?.importance ?? DEFAULT_DEFAULTS.importance,
    sessionRecentLimit:
      options.defaults?.sessionRecentLimit ?? DEFAULT_DEFAULTS.sessionRecentLimit,
    searchLimit: options.defaults?.searchLimit ?? DEFAULT_DEFAULTS.searchLimit,
    similarity: options.defaults?.similarity ?? DEFAULT_DEFAULTS.similarity,
  }

  validateDefaults(defaults)

  // Emit a one-time warning for each disabled type so operators see it in logs.
  for (const t of disabled) {
    // eslint-disable-next-line no-console
    console.warn(
      `[mongodb-memory] Memory type "${t}" is disabled — its tool commands ` +
        `will be removed from the memory tool schema and its collection will ` +
        `not be bootstrapped.`
    )
  }
  // Separate, quieter notice for types that are live-but-hidden from the tool.
  for (const t of hiddenFromTool) {
    if (disabled.has(t)) continue
    // eslint-disable-next-line no-console
    console.info(
      `[mongodb-memory] Memory type "${t}" is hidden from the tool schema ` +
        `but its store and collection remain active (expected when using ` +
        `runtime hooks).`
    )
  }

  return {
    dbName,
    defaultUserId: options.userId ?? 'default',
    defaultSessionId: options.sessionId ?? 'default',
    collections,
    vectorIndexNames,
    disabled,
    hiddenFromTool,
    extraFilterFields,
    retention,
    filtering,
    defaults,
  }
}

// ─── Validators ───────────────────────────────────────────────────────────────

function validateRetention(retention: MemoryConfig['retention']): void {
  for (const [type, policy] of Object.entries(retention) as Array<
    [keyof MemoryConfig['retention'], MemoryConfig['retention'][keyof MemoryConfig['retention']]]
  >) {
    if (policy.mode === 'ttl' || policy.mode === 'ttl+importance') {
      if (!Number.isFinite(policy.ttlSeconds) || policy.ttlSeconds <= 0) {
        throw new Error(
          `[mongodb-memory] retention.${type}: ttlSeconds must be a positive number`
        )
      }
    }
    if (policy.mode === 'ttl+importance') {
      if (
        !Number.isFinite(policy.minImportance) ||
        policy.minImportance < 1 ||
        policy.minImportance > 10
      ) {
        throw new Error(
          `[mongodb-memory] retention.${type}: minImportance must be between 1 and 10`
        )
      }
    }
    if (policy.mode === 'dynamic') {
      if (typeof policy.computeExpireAt !== 'function') {
        throw new Error(
          `[mongodb-memory] retention.${type}: computeExpireAt must be a function`
        )
      }
    }
  }
}

function validateDefaults(defaults: Required<MemoryConfig['defaults']>): void {
  if (defaults.importance < 1 || defaults.importance > 10) {
    throw new Error('[mongodb-memory] defaults.importance must be between 1 and 10')
  }
  if (defaults.sessionRecentLimit <= 0) {
    throw new Error('[mongodb-memory] defaults.sessionRecentLimit must be positive')
  }
  if (defaults.searchLimit <= 0) {
    throw new Error('[mongodb-memory] defaults.searchLimit must be positive')
  }
  const validSimilarity = ['cosine', 'dotProduct', 'euclidean']
  if (!validSimilarity.includes(defaults.similarity)) {
    throw new Error(
      `[mongodb-memory] defaults.similarity must be one of: ${validSimilarity.join(', ')}`
    )
  }
}
