import { MongoClient, Db, Collection, ObjectId, Filter, Document } from 'mongodb'
import type { DriverInfo } from 'mongodb'
import { version } from '../package.json'

const DRIVER_INFO: DriverInfo = { name: 'vercel-ai-memory', version }
import { EmbeddingAdapter } from './embeddings'
import type {
  SessionMemory,
  SemanticMemory,
  ProceduralMemory,
  EpisodicMemory,
  ScratchpadMemory,
  UsageStats,
  MemoryConfig,
  MemoryType,
  VectorMemoryType,
  DecayPolicy,
  DecayInput,
} from './types'

export type SessionAppendInput = {
  role: SessionMemory['role']
  content: string
  toolName?: string
  tokenCount?: number
}

// ─── Names ────────────────────────────────────────────────────────────────────
// The default collection/index names are defined in src/config.ts — we only
// reference them indirectly through the resolved MemoryConfig here.

function defaultStats(): UsageStats {
  return { retrieval_ct: 0, avg_importance: 0, last_retrieved: new Date() }
}

/** TTL index name convention for the always-on expire_at index. */
const EXPIRE_AT_INDEX_NAME = 'expire_at_ttl'

/** All valid memory types — used to reject unknown types at the store boundary. */
const MEMORY_TYPES: readonly MemoryType[] = [
  'session',
  'semantic',
  'procedural',
  'episodic',
  'scratchpad',
]

/**
 * MongoDB-backed store for all 5 memory types:
 * Session, Semantic, Procedural, Episodic, Scratchpad.
 */
export class MongoMemoryStore {
  private db: Db
  private embedder: EmbeddingAdapter
  private config: MemoryConfig

  private session: Collection<SessionMemory>
  private semantic: Collection<SemanticMemory>
  private procedural: Collection<ProceduralMemory>
  private episodic: Collection<EpisodicMemory>
  private scratchpad: Collection<ScratchpadMemory>

  /**
   * Construct a store.
   *
   * Two overloads for backward compatibility:
   *   - `new MongoMemoryStore(client, embedder, dbName)`  ← legacy
   *   - `new MongoMemoryStore(client, embedder, config)`  ← preferred
   */
  constructor(client: MongoClient, embedder: EmbeddingAdapter, configOrDbName: MemoryConfig | string) {
    this.embedder = embedder
    this.config = typeof configOrDbName === 'string'
      ? this._makeLegacyConfig(configOrDbName)
      : configOrDbName

    if (typeof client.appendMetadata === 'function') {
      client.appendMetadata(DRIVER_INFO)
    }
    this.db = client.db(this.config.dbName)
    this.session = this.db.collection<SessionMemory>(this.config.collections.session)
    this.semantic = this.db.collection<SemanticMemory>(this.config.collections.semantic)
    this.procedural = this.db.collection<ProceduralMemory>(this.config.collections.procedural)
    this.episodic = this.db.collection<EpisodicMemory>(this.config.collections.episodic)
    this.scratchpad = this.db.collection<ScratchpadMemory>(this.config.collections.scratchpad)
  }

  /**
   * Build a minimal MemoryConfig from a legacy dbName-only constructor call.
   * Keeps existing tests/users that construct the store directly working.
   */
  private _makeLegacyConfig(dbName: string): MemoryConfig {
    return {
      dbName,
      defaultUserId: 'default',
      defaultSessionId: 'default',
      autoEmbed: null,
      collections: {
        session: 'session_memory',
        semantic: 'semantic_memory',
        procedural: 'procedural_memory',
        episodic: 'episodic_memory',
        scratchpad: 'scratchpad_memory',
      },
      vectorIndexNames: {
        semantic: 'semantic_vector_index',
        procedural: 'procedural_vector_index',
        episodic: 'episodic_vector_index',
      },
      disabled: new Set<MemoryType>(),
      hiddenFromTool: new Set<MemoryType>(),
      extraFilterFields: { semantic: [], procedural: [], episodic: [] },
      retention: {
        session: { mode: 'ttl', ttlSeconds: 86_400, field: 'created_at' },
        scratchpad: { mode: 'ttl', ttlSeconds: 3_600, field: 'created_at' },
        episodic: { mode: 'ttl', ttlSeconds: 31_536_000, field: 'stats.last_retrieved' },
        semantic: { mode: 'none' },
        procedural: { mode: 'none' },
      },
      keepHistory: false,
      filtering: { minImportance: 0, recencyWindowHours: 0, numCandidatesMultiplier: 10 },
      defaults: { importance: 5, sessionRecentLimit: 40, searchLimit: 5, similarity: 'cosine' },
    }
  }

  /** Return true if the given memory type is enabled. */
  private _enabled(type: MemoryType): boolean {
    return !this.config.disabled.has(type)
  }

  /**
   * Fail closed on a missing / empty scope identifier. Scope values
   * (`userId`, `sessionId`) partition every read and write, so an empty value
   * would silently collapse users into a shared bucket.
   *
   * `value` is typed `unknown` on purpose: this is a runtime guard. TS types
   * are erased, and these public methods are reachable from plain JS or
   * `any`-typed input (request bodies, external principals). A non-string such
   * as `{ $ne: null }` would otherwise become a query operator matching every
   * owner. `asserts value is string` narrows the type for the caller.
   */
  private _assertScope(name: 'userId' | 'sessionId', value: unknown): asserts value is string {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new Error(
        `[mongodb-memory] \`${name}\` is required and must be a non-empty string ` +
          '(derive it from your trusted, server-side auth context).'
      )
    }
  }

  /** True when this store uses Atlas Automated Embedding (server-side vectors). */
  private get _isAutoEmbed(): boolean {
    return this.config.autoEmbed !== null
  }

  /**
   * The document field name that holds the vector-search source.
   * - Client mode: `embedding` (a `number[]` produced by the client embedder).
   * - Auto-embed mode: `embed_text` (the raw text Atlas embeds server-side).
   */
  private get _vectorPath(): string {
    return this._isAutoEmbed ? 'embed_text' : 'embedding'
  }

  /**
   * Build the vector field for a save. In client mode this embeds `text` and
   * returns `{ embedding }`; in auto-embed mode it returns `{ embed_text: text }`
   * and lets Atlas embed server-side.
   */
  private async _vectorFieldFor(text: string): Promise<Record<string, unknown>> {
    if (this._isAutoEmbed) return { embed_text: text }
    return { embedding: await this.embedder.embedText(text) }
  }

  /**
   * Build the `$vectorSearch` stage. In client mode it embeds `query` and passes
   * `queryVector`; in auto-embed mode it passes the `query` text (and optional
   * `model`) so Atlas embeds server-side.
   */
  private async _vectorSearchStage(
    type: VectorMemoryType,
    query: string,
    limit: number,
    filter: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const mult = this.config.filtering.numCandidatesMultiplier
    const base: Record<string, unknown> = {
      index: this.config.vectorIndexNames[type],
      path: this._vectorPath,
      numCandidates: limit * mult,
      limit,
      filter,
    }
    if (this._isAutoEmbed) {
      base.query = query
      const queryModel = this.config.autoEmbed!.queryModel
      if (queryModel) base.model = queryModel
    } else {
      base.queryVector = await this.embedder.embedText(query)
    }
    return { $vectorSearch: base }
  }

  /** Default TTL field for a given memory type. */
  private _defaultTtlField(type: MemoryType): string {
    switch (type) {
      case 'episodic':
        return 'stats.last_retrieved'
      default:
        return 'created_at'
    }
  }

  // ─── Bootstrap ──────────────────────────────────────────────────────────────

  /**
   * Idempotent setup — creates all TTL and Atlas Vector Search indexes.
   * Should be called once on startup.
   */
  async bootstrap(): Promise<void> {
    // ── Regular + decay indexes, per memory type ─────────────────────────────
    // Widen typed collections to Document-shaped ones for the generic helpers.
    const asDoc = (c: unknown): Collection<Document> =>
      c as Collection<Document>

    if (this._enabled('session')) {
      await this._applyDecayIndex(asDoc(this.session), 'session', this.config.retention.session)
      await this._ensureExpireAtIndex(asDoc(this.session))
      await this.session.createIndex(
        { session_id: 1, seq: 1 },
        { unique: true, background: true, name: 'session_seq_unique' }
      )
      await this.session.createIndex({ session_id: 1, seq: -1 }, { background: true })
      await this.session.createIndex({ session_id: 1, role: 1 }, { background: true })
      // Owner-first index backing the user-scoped session reads.
      await this.session.createIndex(
        { user_id: 1, session_id: 1, seq: -1 },
        { background: true, name: 'session_user_seq' }
      )
    }

    if (this._enabled('scratchpad')) {
      await this._applyDecayIndex(asDoc(this.scratchpad), 'scratchpad', this.config.retention.scratchpad)
      await this._ensureExpireAtIndex(asDoc(this.scratchpad))
      await this.scratchpad.createIndex({ session_id: 1, created_at: -1 }, { background: true })
      await this.scratchpad.createIndex(
        { user_id: 1, session_id: 1, created_at: -1 },
        { background: true, name: 'scratchpad_user_session' }
      )
    }

    if (this._enabled('semantic')) {
      await this._applyDecayIndex(asDoc(this.semantic), 'semantic', this.config.retention.semantic)
      await this._ensureExpireAtIndex(asDoc(this.semantic))
      await this.semantic.createIndex({ user_id: 1, name: 1, timestamp: -1 }, { background: true })
      await this.semantic.createIndex({ user_id: 1, category: 1 }, { background: true })
      await this.semantic.createIndex(
        { user_id: 1, name: 1, is_latest: 1 },
        {
          unique: true,
          background: true,
          name: 'semantic_latest_unique',
          partialFilterExpression: { is_latest: true },
        }
      )
    }

    if (this._enabled('procedural')) {
      await this._applyDecayIndex(asDoc(this.procedural), 'procedural', this.config.retention.procedural)
      await this._ensureExpireAtIndex(asDoc(this.procedural))
      await this.procedural.createIndex({ user_id: 1, category: 1 }, { background: true })
      await this.procedural.createIndex({ task: 1 }, { background: true })
      await this.procedural.createIndex(
        { user_id: 1, task: 1, is_latest: 1 },
        {
          unique: true,
          background: true,
          name: 'procedural_latest_unique',
          partialFilterExpression: { is_latest: true },
        }
      )
    }

    if (this._enabled('episodic')) {
      await this._applyDecayIndex(asDoc(this.episodic), 'episodic', this.config.retention.episodic)
      await this._ensureExpireAtIndex(asDoc(this.episodic))
      await this.episodic.createIndex({ user_id: 1, timestamp: -1 }, { background: true })
      await this.episodic.createIndex({ user_id: 1, event_type: 1, timestamp: -1 }, { background: true })
    }

    // ── Atlas Vector Search indexes ──────────────────────────────────────────
    // In client mode we probe embedding dimensions; in auto-embed mode Atlas
    // owns dimensions, so we skip the probe entirely.
    const dims = this._isAutoEmbed ? 0 : await this.embedder.getDimensions()
    if (this._enabled('semantic')) {
      await this._createVectorIndex(
        this.config.collections.semantic,
        this.config.vectorIndexNames.semantic,
        dims,
        ['user_id', 'is_latest', ...this.config.extraFilterFields.semantic]
      )
    }
    if (this._enabled('procedural')) {
      await this._createVectorIndex(
        this.config.collections.procedural,
        this.config.vectorIndexNames.procedural,
        dims,
        ['user_id', 'is_latest', ...this.config.extraFilterFields.procedural]
      )
    }
    if (this._enabled('episodic')) {
      await this._createVectorIndex(
        this.config.collections.episodic,
        this.config.vectorIndexNames.episodic,
        dims,
        ['user_id', ...this.config.extraFilterFields.episodic]
      )
    }
  }

  /**
   * Create the decay TTL index appropriate to the given policy.
   * Uses deterministic index names so repeated bootstraps are idempotent.
   */
  private async _applyDecayIndex(
    collection: Collection<Document>,
    type: MemoryType,
    policy: DecayPolicy
  ): Promise<void> {
    if (policy.mode === 'none') return

    if (policy.mode === 'ttl') {
      const field = policy.field ?? this._defaultTtlField(type)
      await collection.createIndex(
        { [field]: 1 },
        { expireAfterSeconds: policy.ttlSeconds, background: true, name: `${type}_ttl` }
      )
      return
    }

    if (policy.mode === 'ttl+importance') {
      const field = policy.field ?? this._defaultTtlField(type)
      await collection.createIndex(
        { [field]: 1 },
        {
          expireAfterSeconds: policy.ttlSeconds,
          background: true,
          name: `${type}_ttl_importance`,
          partialFilterExpression: { importance: { $lt: policy.minImportance } },
        }
      )
      return
    }

    // mode === 'dynamic' — decay is driven by the always-on expire_at index;
    // no additional index is created here.
  }

  /**
   * Always-on `{ expire_at: 1 }` TTL index with `expireAfterSeconds: 0`.
   * Docs with `expire_at` unset are ignored by the TTL monitor.
   * Powers: dynamic decay, agent-driven `memory_forget`, manual expiry.
   */
  private async _ensureExpireAtIndex(
    collection: Collection<Record<string, unknown>>
  ): Promise<void> {
    await collection.createIndex(
      { expire_at: 1 },
      { expireAfterSeconds: 0, background: true, name: EXPIRE_AT_INDEX_NAME }
    )
  }

  private async _createVectorIndex(
    collection: string,
    indexName: string,
    numDimensions: number,
    filterFields: string[] = []
  ): Promise<void> {
    // Choose the vector field definition based on embedding mode:
    // - Auto-embed: `type: 'autoEmbed'` on the `embed_text` field; Atlas owns
    //   dimensions and embedding generation (Voyage AI `model`).
    // - Client:     `type: 'vector'` on the `embedding` field with numDimensions.
    const desiredType = this._isAutoEmbed ? 'autoEmbed' : 'vector'
    const vectorField = this._isAutoEmbed
      ? {
          type: 'autoEmbed',
          modality: 'text',
          path: 'embed_text',
          model: this.config.autoEmbed!.model,
        }
      : {
          type: 'vector',
          path: 'embedding',
          numDimensions,
          similarity: this.config.defaults.similarity,
        }

    // If an index with this name already exists, check whether it matches the
    // desired mode. A stale index of the wrong type (e.g. a client-mode
    // `vector` index left over from a previous run when we now want
    // `autoEmbed`) would otherwise silently shadow the correct one — the docs
    // would still be written, but queries would never match. Detect and fix it.
    const existingType = await this._existingVectorFieldType(collection, indexName)
    if (existingType) {
      if (existingType === desiredType) return // already correct — nothing to do
      // Wrong type for the current embedding mode. Recreate it.
      // eslint-disable-next-line no-console
      console.warn(
        `[mongodb-memory] Vector index "${indexName}" on "${collection}" is ` +
          `type "${existingType}" but this store is in "${desiredType}" mode. ` +
          `Dropping and recreating it.`
      )
      try {
        await this.db.command({ dropSearchIndex: collection, name: indexName })
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        // eslint-disable-next-line no-console
        console.warn(
          `[mongodb-memory] Could not drop stale index "${indexName}" on ` +
            `"${collection}": ${msg}. Drop it manually if search returns nothing.`
        )
        return
      }
    }

    try {
      await this.db.command({
        createSearchIndexes: collection,
        indexes: [
          {
            name: indexName,
            type: 'vectorSearch',
            definition: {
              fields: [
                vectorField,
                ...filterFields.map((path) => ({ type: 'filter', path })),
              ],
            },
          },
        ],
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.includes('already exists') || msg.includes('Duplicate')) return
      // Surface the real reason (e.g. Voyage AI not enabled, invalid model,
      // unsupported field) instead of failing silently. Bootstrap continues so
      // one bad index doesn't block the others, but the operator sees why.
      // eslint-disable-next-line no-console
      console.warn(
        `[mongodb-memory] Failed to create vector index "${indexName}" on ` +
          `"${collection}" (${desiredType} mode): ${msg}`
      )
    }
  }

  /**
   * Return the vector-field `type` of an existing search index by name
   * (`'vector'`, `'autoEmbed'`, or the first field's type), or `null` if the
   * index does not exist or can't be introspected.
   */
  private async _existingVectorFieldType(
    collection: string,
    indexName: string
  ): Promise<string | null> {
    try {
      const col = this.db.collection(collection)
      // listSearchIndexes may not exist on very old drivers — guard for it.
      const lister = (col as unknown as {
        listSearchIndexes?: (name: string) => { toArray: () => Promise<Array<Record<string, unknown>>> }
      }).listSearchIndexes
      if (typeof lister !== 'function') return null
      const indexes = await lister.call(col, indexName).toArray()
      const idx = indexes.find((i) => i.name === indexName)
      if (!idx) return null
      const def = (idx.latestDefinition ?? idx.definition) as
        | { fields?: Array<{ type?: string }> }
        | undefined
      const fields = def?.fields ?? []
      const vf = fields.find((f) => f.type === 'vector' || f.type === 'autoEmbed')
      return vf?.type ?? fields[0]?.type ?? null
    } catch {
      // Best-effort introspection; if it fails, fall through to create.
      return null
    }
  }

  // ─── Decay helpers ──────────────────────────────────────────────────────────

  /**
   * Compute an optional `expire_at` value for a new or refreshed doc.
   * Returns `undefined` for non-dynamic policies (field stays unset).
   */
  private _computeExpireAtFor(
    type: MemoryType,
    input: DecayInput
  ): Date | undefined {
    const policy = this.config.retention[type as keyof MemoryConfig['retention']]
    if (policy.mode !== 'dynamic') return undefined
    const result = policy.computeExpireAt(input)
    return result ?? undefined
  }

  /**
   * Should we refresh expire_at on retrieval for a given type?
   * True only for dynamic policies with refreshOnRead !== false.
   */
  private _refreshOnRead(type: MemoryType): boolean {
    const policy = this.config.retention[type as keyof MemoryConfig['retention']]
    if (policy.mode !== 'dynamic') return false
    return policy.refreshOnRead !== false
  }

  // ─── Session Memory ──────────────────────────────────────────────────────────

  async sessionAppend(
    userId: string,
    sessionId: string,
    role: SessionMemory['role'],
    content: string,
    opts?: { toolName?: string; tokenCount?: number }
  ): Promise<void> {
    await this.sessionAppendMany(userId, sessionId, [{
      role,
      content,
      toolName: opts?.toolName,
      tokenCount: opts?.tokenCount,
    }])
  }

  async sessionAppendMany(
    userId: string,
    sessionId: string,
    turns: SessionAppendInput[]
  ): Promise<void> {
    this._assertScope('userId', userId)
    this._assertScope('sessionId', sessionId)
    if (!this._enabled('session')) {
      throw new Error('[mongodb-memory] Session memory is disabled')
    }
    if (turns.length === 0) return

    // Get next seq number.
    // Intentionally keyed by `session_id` only (not `user_id`): seq is
    // allocated per session to match the `session_seq_unique` index on
    // `{ session_id, seq }`. Adding `user_id` here would let two owners sharing
    // a session id compute colliding seqs and hit duplicate-key errors. Reads
    // (`sessionRecent`) are scoped by `user_id` + `session_id`, so no content
    // crosses owners. Moving to per-owner seq requires migrating that unique
    // index to `{ user_id, session_id, seq }` — tracked as a follow-up.
    const last = await this.session
      .find({ session_id: sessionId }, { projection: { seq: 1 }, sort: { seq: -1 }, limit: 1 })
      .toArray()
    const baseSeq = last.length > 0 ? last[0].seq + 1 : 0

    const createdAt = new Date()
    const expireAt = this._computeExpireAtFor('session', {
      importance: 0,
      createdAt,
    })

    await this.session.insertMany(
      turns.map((turn, i) => ({
        _id: new ObjectId(),
        session_id: sessionId,
        user_id: userId,
        seq: baseSeq + i,
        role: turn.role,
        content: turn.content,
        tool_name: turn.toolName,
        token_count: turn.tokenCount,
        created_at: createdAt,
        ...(expireAt ? { expire_at: expireAt } : {}),
      })),
      { ordered: true }
    )
  }

  /**
   * Most recent turns of a session, in chronological order.
   *
   * Scoped by **both** `userId` and `sessionId`: a caller that knows (or
   * guesses) another user's session id still gets nothing back.
   */
  async sessionRecent(
    userId: string,
    sessionId: string,
    limit = this.config.defaults.sessionRecentLimit
  ): Promise<SessionMemory[]> {
    this._assertScope('userId', userId)
    this._assertScope('sessionId', sessionId)
    if (!this._enabled('session')) return []
    const docs = await this.session
      .find(
        { user_id: userId, session_id: sessionId },
        { projection: { embedding: 0 }, sort: { seq: -1 }, limit }
      )
      .toArray()
    return docs.reverse() // return chronological order
  }

  // ─── Semantic Memory ─────────────────────────────────────────────────────────

  async semanticSave(
    userId: string,
    name: string,
    description: string,
    opts?: { importance?: number; tags?: string[] }
  ): Promise<void> {
    this._assertScope('userId', userId)
    if (!this._enabled('semantic')) {
      throw new Error('[mongodb-memory] Semantic memory is disabled')
    }
    const vectorField = await this._vectorFieldFor(`${name}: ${description}`)
    const now = new Date()
    const importance = opts?.importance ?? this.config.defaults.importance

    const expireAt = this._computeExpireAtFor('semantic', {
      importance,
      createdAt: now,
    })

    if (this.config.keepHistory) {
      // Temporal versioning: mark old docs not-latest, then insert a new one.
      await this.semantic.updateMany(
        { user_id: userId, name },
        { $set: { is_latest: false } }
      )

      await this.semantic.insertOne({
        _id: new ObjectId(),
        user_id: userId,
        name,
        category: 'semantic',
        description,
        ...vectorField,
        importance,
        stats: defaultStats(),
        timestamp: now,
        is_latest: true,
        tags: opts?.tags,
        ...(expireAt ? { expire_at: expireAt } : {}),
      } as unknown as SemanticMemory)
    } else {
      // In-place upsert: single document per (user_id, name).
      await this.semantic.updateOne(
        { user_id: userId, name },
        {
          $set: {
            description,
            ...vectorField,
            importance,
            timestamp: now,
            is_latest: true,
            tags: opts?.tags,
            ...(expireAt ? { expire_at: expireAt } : {}),
          },
          $setOnInsert: {
            _id: new ObjectId(),
            user_id: userId,
            name,
            category: 'semantic' as const,
            stats: defaultStats(),
          },
        },
        { upsert: true }
      )
    }
  }

  async semanticSearch(
    userId: string,
    query: string,
    limit = this.config.defaults.searchLimit
  ): Promise<SemanticMemory[]> {
    this._assertScope('userId', userId)
    if (!this._enabled('semantic')) return []
    const stage = await this._vectorSearchStage('semantic', query, limit, {
      user_id: { $eq: userId },
      is_latest: { $eq: true },
    })
    const results = await this.semantic
      .aggregate<SemanticMemory>([
        stage,
        ...this._postFilterStages(),
        { $project: { embedding: 0 } },
      ])
      .toArray()

    await this._refreshRetrievalStats(this.semantic, 'semantic', results)

    return results
  }

  // ─── Procedural Memory ───────────────────────────────────────────────────────

  async proceduralSave(
    userId: string,
    task: string,
    description: string,
    opts?: {
      importance?: number
      source?: ProceduralMemory['source']
    }
  ): Promise<void> {
    this._assertScope('userId', userId)
    if (!this._enabled('procedural')) {
      throw new Error('[mongodb-memory] Procedural memory is disabled')
    }
    const vectorField = await this._vectorFieldFor(`${task}: ${description}`)
    const now = new Date()
    const importance = opts?.importance ?? this.config.defaults.importance
    const source = opts?.source ?? 'agent_learned'

    const expireAt = this._computeExpireAtFor('procedural', {
      importance,
      createdAt: now,
    })

    if (this.config.keepHistory) {
      // Temporal versioning: mark old docs not-latest, then insert a new one.
      await this.procedural.updateMany(
        { user_id: userId, task },
        { $set: { is_latest: false } }
      )

      await this.procedural.insertOne({
        _id: new ObjectId(),
        user_id: userId,
        task,
        category: 'procedural',
        description,
        ...vectorField,
        importance,
        stats: defaultStats(),
        source,
        timestamp: now,
        is_latest: true,
        ...(expireAt ? { expire_at: expireAt } : {}),
      } as unknown as ProceduralMemory)
    } else {
      // In-place upsert: single document per (user_id, task).
      await this.procedural.updateOne(
        { user_id: userId, task },
        {
          $set: {
            description,
            ...vectorField,
            importance,
            source,
            timestamp: now,
            is_latest: true,
            ...(expireAt ? { expire_at: expireAt } : {}),
          },
          $setOnInsert: {
            _id: new ObjectId(),
            user_id: userId,
            task,
            category: 'procedural' as const,
            stats: defaultStats(),
          },
        },
        { upsert: true }
      )
    }
  }

  async proceduralSearch(
    userId: string,
    query: string,
    limit = this.config.defaults.searchLimit
  ): Promise<ProceduralMemory[]> {
    this._assertScope('userId', userId)
    if (!this._enabled('procedural')) return []
    const stage = await this._vectorSearchStage('procedural', query, limit, {
      user_id: { $eq: userId },
      is_latest: { $eq: true },
    })
    const results = await this.procedural
      .aggregate<ProceduralMemory>([
        stage,
        ...this._postFilterStages(),
        { $project: { embedding: 0 } },
      ])
      .toArray()

    await this._refreshRetrievalStats(this.procedural, 'procedural', results)

    return results
  }

  // ─── Episodic Memory ─────────────────────────────────────────────────────────

  async episodicSave(
    userId: string,
    eventType: string,
    description: string,
    opts?: {
      importance?: number
      context?: Record<string, unknown>
    }
  ): Promise<ObjectId> {
    this._assertScope('userId', userId)
    if (!this._enabled('episodic')) {
      throw new Error('[mongodb-memory] Episodic memory is disabled')
    }
    const vectorField = await this._vectorFieldFor(`${eventType}: ${description}`)
    const id = new ObjectId()
    const now = new Date()
    const importance = opts?.importance ?? this.config.defaults.importance

    const expireAt = this._computeExpireAtFor('episodic', {
      importance,
      createdAt: now,
    })

    await this.episodic.insertOne({
      _id: id,
      user_id: userId,
      event_type: eventType,
      category: 'episodic',
      description,
      ...vectorField,
      importance,
      stats: defaultStats(),
      context: opts?.context,
      timestamp: now,
      ...(expireAt ? { expire_at: expireAt } : {}),
    } as unknown as EpisodicMemory)

    return id
  }

  /**
   * Return true if at least one episodic doc for `userId` matches `filter`.
   * Used by the Eve adapter to make replayed captures idempotent.
   *
   * The owner scope is applied last, so a `user_id` key inside `filter` can
   * never widen or replace the caller's scope.
   */
  async episodicExists(
    userId: string,
    filter: Record<string, unknown>
  ): Promise<boolean> {
    this._assertScope('userId', userId)
    if (!this._enabled('episodic')) return false
    const doc = await this.episodic.findOne(
      { ...filter, user_id: userId } as Filter<EpisodicMemory>,
      { projection: { _id: 1 } }
    )
    return doc !== null
  }

  async episodicSearch(
    userId: string,
    query: string,
    limit = this.config.defaults.searchLimit
  ): Promise<EpisodicMemory[]> {
    this._assertScope('userId', userId)
    if (!this._enabled('episodic')) return []
    const stage = await this._vectorSearchStage('episodic', query, limit, {
      user_id: { $eq: userId },
    })
    const results = await this.episodic
      .aggregate<EpisodicMemory>([
        stage,
        ...this._postFilterStages(),
        { $project: { embedding: 0 } },
      ])
      .toArray()

    await this._refreshRetrievalStats(this.episodic, 'episodic', results)

    return results
  }

  // ─── Scratchpad Memory ───────────────────────────────────────────────────────

  async scratchpadWrite(userId: string, sessionId: string, note: string): Promise<ObjectId> {
    this._assertScope('userId', userId)
    this._assertScope('sessionId', sessionId)
    if (!this._enabled('scratchpad')) {
      throw new Error('[mongodb-memory] Scratchpad memory is disabled')
    }
    const id = new ObjectId()
    const createdAt = new Date()
    const expireAt = this._computeExpireAtFor('scratchpad', {
      importance: 0,
      createdAt,
    })

    await this.scratchpad.insertOne({
      _id: id,
      session_id: sessionId,
      user_id: userId,
      note,
      promoted: false,
      created_at: createdAt,
      ...(expireAt ? { expire_at: expireAt } : {}),
    })
    return id
  }

  /** Unpromoted scratchpad notes for a session, scoped by `userId` + `sessionId`. */
  async scratchpadRead(userId: string, sessionId: string): Promise<ScratchpadMemory[]> {
    this._assertScope('userId', userId)
    this._assertScope('sessionId', sessionId)
    if (!this._enabled('scratchpad')) return []
    return this.scratchpad
      .find(
        { user_id: userId, session_id: sessionId, promoted: false },
        { sort: { created_at: 1 } }
      )
      .toArray()
  }

  async scratchpadPromote(
    scratchpadId: string,
    userId: string,
    eventType: string,
    opts?: { importance?: number; context?: Record<string, unknown> }
  ): Promise<{ episodicId: ObjectId }> {
    this._assertScope('userId', userId)
    if (!this._enabled('scratchpad')) {
      throw new Error('[mongodb-memory] Scratchpad memory is disabled')
    }
    // Atomically claim an unpromoted note owned by the caller. A note belonging
    // to another user is reported as "not found" (never promoted, never leaked
    // into this user's episodic memory), and concurrent promotions of the same
    // note cannot both succeed.
    const doc = ObjectId.isValid(scratchpadId)
      ? await this.scratchpad.findOneAndUpdate(
          { _id: new ObjectId(scratchpadId), user_id: userId, promoted: false },
          { $set: { promoted: true } },
          { returnDocument: 'before' }
        )
      : null
    if (!doc) throw new Error(`Scratchpad note ${scratchpadId} not found`)

    let episodicId: ObjectId
    try {
      episodicId = await this.episodicSave(userId, eventType, doc.note, opts)
    } catch (err) {
      // Release the claim so the note can be promoted again later.
      await this.scratchpad.updateOne(
        { _id: doc._id, user_id: userId, promoted_to_id: { $exists: false } },
        { $set: { promoted: false } }
      )
      throw err
    }

    await this.scratchpad.updateOne(
      { _id: doc._id, user_id: userId },
      { $set: { promoted_to_id: episodicId } }
    )

    return { episodicId }
  }

  // ─── Agent-driven deletion (memory_forget) ──────────────────────────────────

  /**
   * Mark a document for near-immediate deletion by setting `expire_at` to now.
   * The always-on `{ expire_at: 1 }` TTL index reaps it within ~60s.
   *
   * Runs automatically (no approval step) but is **owner-scoped**: the update
   * filter is `{ _id, user_id }`, so a caller can only ever forget memories
   * that belong to its own trusted scope. An id owned by another user — or a
   * malformed id — is reported as "not found" and nothing is modified.
   *
   * @param userId Trusted owner scope (server-side userId / Eve scope key).
   * @returns true if a doc owned by `userId` was found and marked, false otherwise.
   */
  async forget(userId: string, type: MemoryType, id: string): Promise<boolean> {
    this._assertScope('userId', userId)
    if (!MEMORY_TYPES.includes(type)) {
      throw new Error(`[mongodb-memory] Unknown memory type "${String(type)}"`)
    }
    if (!this._enabled(type)) {
      throw new Error(`[mongodb-memory] "${type}" memory is disabled`)
    }
    if (typeof id !== 'string' || !ObjectId.isValid(id)) return false
    const collection = this._collectionFor(type)
    const result = await collection.updateOne(
      { _id: new ObjectId(id), user_id: userId } as Filter<Record<string, unknown>>,
      { $set: { expire_at: new Date() } }
    )
    return result.matchedCount > 0
  }

  private _collectionFor(type: MemoryType): Collection<Record<string, unknown>> {
    switch (type) {
      case 'session': return this.session as unknown as Collection<Record<string, unknown>>
      case 'semantic': return this.semantic as unknown as Collection<Record<string, unknown>>
      case 'procedural': return this.procedural as unknown as Collection<Record<string, unknown>>
      case 'episodic': return this.episodic as unknown as Collection<Record<string, unknown>>
      case 'scratchpad': return this.scratchpad as unknown as Collection<Record<string, unknown>>
    }
  }

  // ─── Internal — retrieval-time side-effects ─────────────────────────────────

  /**
   * Build optional `$match` stages applied after `$vectorSearch` to enforce
   * retrieval-time filters configured in `filtering.*`.
   */
  private _postFilterStages(): Array<Record<string, unknown>> {
    const stages: Array<Record<string, unknown>> = []
    const { minImportance, recencyWindowHours } = this.config.filtering

    if (minImportance && minImportance > 0) {
      stages.push({ $match: { importance: { $gte: minImportance } } })
    }
    if (recencyWindowHours && recencyWindowHours > 0) {
      const cutoff = new Date(Date.now() - recencyWindowHours * 3_600_000)
      stages.push({ $match: { 'stats.last_retrieved': { $gte: cutoff } } })
    }
    return stages
  }

  /**
   * Bump retrieval stats and, if the policy is dynamic + refreshOnRead,
   * recompute `expire_at` per-doc (forgetting-curve behavior).
   *
   * Best-effort / fire-and-forget semantics: failures are swallowed.
   */
  private async _refreshRetrievalStats<
    T extends { _id: ObjectId; importance: number; stats: UsageStats; timestamp?: Date; created_at?: Date }
  >(
    collection: Collection<T>,
    type: VectorMemoryType,
    results: T[]
  ): Promise<void> {
    if (results.length === 0) return

    // Widen to Document for writes — our doc shape uses dotted paths like
    // `stats.retrieval_ct` that the strict generic types don't express.
    const col = collection as unknown as Collection<Document>

    const now = new Date()
    const refresh = this._refreshOnRead(type)

    if (!refresh) {
      // Classic path: single bulk update.
      const ids = results.map((r) => r._id)
      col
        .updateMany(
          { _id: { $in: ids } },
          {
            $inc: { 'stats.retrieval_ct': 1 },
            $set: { 'stats.last_retrieved': now },
          }
        )
        .catch(() => {})
      return
    }

    // Dynamic + refreshOnRead: per-doc expire_at recomputation.
    const policy = this.config.retention[type]
    if (policy.mode !== 'dynamic') return

    const writes = results.map((doc) => {
      const nextStats: UsageStats = {
        retrieval_ct: (doc.stats?.retrieval_ct ?? 0) + 1,
        avg_importance: doc.stats?.avg_importance ?? 0,
        last_retrieved: now,
      }
      const createdAt = doc.timestamp ?? doc.created_at ?? now
      const nextExpireAt = policy.computeExpireAt({
        importance: doc.importance,
        stats: nextStats,
        createdAt,
      })
      return {
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $inc: { 'stats.retrieval_ct': 1 },
            $set: {
              'stats.last_retrieved': now,
              ...(nextExpireAt ? { expire_at: nextExpireAt } : { expire_at: null }),
            },
          },
        },
      }
    })

    col.bulkWrite(writes, { ordered: false }).catch(() => {})
  }
}
