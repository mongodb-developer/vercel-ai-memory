import { MongoClient, Db, Collection, ObjectId, Filter, Document } from 'mongodb'
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

// ─── Names ────────────────────────────────────────────────────────────────────
// The default collection/index names are defined in src/config.ts — we only
// reference them indirectly through the resolved MemoryConfig here.

function defaultStats(): UsageStats {
  return { retrieval_ct: 0, avg_importance: 0, last_retrieved: new Date() }
}

/** TTL index name convention for the always-on expire_at index. */
const EXPIRE_AT_INDEX_NAME = 'expire_at_ttl'

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
      filtering: { minImportance: 0, recencyWindowHours: 0, numCandidatesMultiplier: 10 },
      defaults: { importance: 5, sessionRecentLimit: 40, searchLimit: 5, similarity: 'cosine' },
    }
  }

  /** Return true if the given memory type is enabled. */
  private _enabled(type: MemoryType): boolean {
    return !this.config.disabled.has(type)
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
      await this.session.createIndex({ session_id: 1, seq: -1 }, { background: true })
      await this.session.createIndex({ session_id: 1, role: 1 }, { background: true })
    }

    if (this._enabled('scratchpad')) {
      await this._applyDecayIndex(asDoc(this.scratchpad), 'scratchpad', this.config.retention.scratchpad)
      await this._ensureExpireAtIndex(asDoc(this.scratchpad))
      await this.scratchpad.createIndex({ session_id: 1, created_at: -1 }, { background: true })
    }

    if (this._enabled('semantic')) {
      await this._applyDecayIndex(asDoc(this.semantic), 'semantic', this.config.retention.semantic)
      await this._ensureExpireAtIndex(asDoc(this.semantic))
      await this.semantic.createIndex({ user_id: 1, name: 1, timestamp: -1 }, { background: true })
      await this.semantic.createIndex({ user_id: 1, category: 1 }, { background: true })
    }

    if (this._enabled('procedural')) {
      await this._applyDecayIndex(asDoc(this.procedural), 'procedural', this.config.retention.procedural)
      await this._ensureExpireAtIndex(asDoc(this.procedural))
      await this.procedural.createIndex({ user_id: 1, category: 1 }, { background: true })
      await this.procedural.createIndex({ task: 1 }, { background: true })
    }

    if (this._enabled('episodic')) {
      await this._applyDecayIndex(asDoc(this.episodic), 'episodic', this.config.retention.episodic)
      await this._ensureExpireAtIndex(asDoc(this.episodic))
      await this.episodic.createIndex({ user_id: 1, timestamp: -1 }, { background: true })
      await this.episodic.createIndex({ user_id: 1, event_type: 1, timestamp: -1 }, { background: true })
    }

    // ── Atlas Vector Search indexes ──────────────────────────────────────────
    const dims = await this.embedder.getDimensions()
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
    try {
      await this.db.command({
        createSearchIndexes: collection,
        indexes: [
          {
            name: indexName,
            type: 'vectorSearch',
            definition: {
              fields: [
                {
                  type: 'vector',
                  path: 'embedding',
                  numDimensions,
                  similarity: this.config.defaults.similarity,
                },
                ...filterFields.map((path) => ({ type: 'filter', path })),
              ],
            },
          },
        ],
      })
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!msg.includes('already exists') && !msg.includes('Duplicate')) {
        console.warn(`[mongodb-memory] Vector index warning (${indexName}): ${msg}`)
      }
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
    if (!this._enabled('session')) {
      throw new Error('[mongodb-memory] Session memory is disabled')
    }
    // Get next seq number
    const last = await this.session
      .find({ session_id: sessionId }, { projection: { seq: 1 }, sort: { seq: -1 }, limit: 1 })
      .toArray()
    const seq = last.length > 0 ? last[0].seq + 1 : 0

    const createdAt = new Date()
    const expireAt = this._computeExpireAtFor('session', {
      importance: 0,
      createdAt,
    })

    await this.session.insertOne({
      _id: new ObjectId(),
      session_id: sessionId,
      user_id: userId,
      seq,
      role,
      content,
      tool_name: opts?.toolName,
      token_count: opts?.tokenCount,
      created_at: createdAt,
      ...(expireAt ? { expire_at: expireAt } : {}),
    })
  }

  async sessionRecent(sessionId: string, limit = this.config.defaults.sessionRecentLimit): Promise<SessionMemory[]> {
    if (!this._enabled('session')) return []
    const docs = await this.session
      .find(
        { session_id: sessionId },
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
    if (!this._enabled('semantic')) {
      throw new Error('[mongodb-memory] Semantic memory is disabled')
    }
    const embedding = await this.embedder.embedText(`${name}: ${description}`)
    const now = new Date()
    const importance = opts?.importance ?? this.config.defaults.importance

    // Mark old versions as not-latest
    await this.semantic.updateMany(
      { user_id: userId, name },
      { $set: { is_latest: false } }
    )

    const expireAt = this._computeExpireAtFor('semantic', {
      importance,
      createdAt: now,
    })

    await this.semantic.insertOne({
      _id: new ObjectId(),
      user_id: userId,
      name,
      category: 'semantic',
      description,
      embedding,
      importance,
      stats: defaultStats(),
      timestamp: now,
      is_latest: true,
      tags: opts?.tags,
      ...(expireAt ? { expire_at: expireAt } : {}),
    })
  }

  async semanticSearch(
    userId: string,
    query: string,
    limit = this.config.defaults.searchLimit
  ): Promise<SemanticMemory[]> {
    if (!this._enabled('semantic')) return []
    const queryVector = await this.embedder.embedText(query)
    const mult = this.config.filtering.numCandidatesMultiplier
    const results = await this.semantic
      .aggregate<SemanticMemory>([
        {
          $vectorSearch: {
            index: this.config.vectorIndexNames.semantic,
            path: 'embedding',
            queryVector,
            numCandidates: limit * mult,
            limit,
            filter: { user_id: { $eq: userId }, is_latest: { $eq: true } },
          },
        },
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
    if (!this._enabled('procedural')) {
      throw new Error('[mongodb-memory] Procedural memory is disabled')
    }
    const embedding = await this.embedder.embedText(`${task}: ${description}`)
    const now = new Date()
    const importance = opts?.importance ?? this.config.defaults.importance

    // Mark old versions as not-latest
    await this.procedural.updateMany(
      { user_id: userId, task },
      { $set: { is_latest: false } }
    )

    const expireAt = this._computeExpireAtFor('procedural', {
      importance,
      createdAt: now,
    })

    await this.procedural.insertOne({
      _id: new ObjectId(),
      user_id: userId,
      task,
      category: 'procedural',
      description,
      embedding,
      importance,
      stats: defaultStats(),
      source: opts?.source ?? 'agent_learned',
      timestamp: now,
      is_latest: true,
      ...(expireAt ? { expire_at: expireAt } : {}),
    })
  }

  async proceduralSearch(
    userId: string,
    query: string,
    limit = this.config.defaults.searchLimit
  ): Promise<ProceduralMemory[]> {
    if (!this._enabled('procedural')) return []
    const queryVector = await this.embedder.embedText(query)
    const mult = this.config.filtering.numCandidatesMultiplier
    const results = await this.procedural
      .aggregate<ProceduralMemory>([
        {
          $vectorSearch: {
            index: this.config.vectorIndexNames.procedural,
            path: 'embedding',
            queryVector,
            numCandidates: limit * mult,
            limit,
            filter: { user_id: { $eq: userId }, is_latest: { $eq: true } },
          },
        },
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
    if (!this._enabled('episodic')) {
      throw new Error('[mongodb-memory] Episodic memory is disabled')
    }
    const embedding = await this.embedder.embedText(`${eventType}: ${description}`)
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
      embedding,
      importance,
      stats: defaultStats(),
      context: opts?.context,
      timestamp: now,
      ...(expireAt ? { expire_at: expireAt } : {}),
    })

    return id
  }

  async episodicSearch(
    userId: string,
    query: string,
    limit = this.config.defaults.searchLimit
  ): Promise<EpisodicMemory[]> {
    if (!this._enabled('episodic')) return []
    const queryVector = await this.embedder.embedText(query)
    const mult = this.config.filtering.numCandidatesMultiplier
    const results = await this.episodic
      .aggregate<EpisodicMemory>([
        {
          $vectorSearch: {
            index: this.config.vectorIndexNames.episodic,
            path: 'embedding',
            queryVector,
            numCandidates: limit * mult,
            limit,
            filter: { user_id: { $eq: userId } },
          },
        },
        ...this._postFilterStages(),
        { $project: { embedding: 0 } },
      ])
      .toArray()

    await this._refreshRetrievalStats(this.episodic, 'episodic', results)

    return results
  }

  // ─── Scratchpad Memory ───────────────────────────────────────────────────────

  async scratchpadWrite(userId: string, sessionId: string, note: string): Promise<ObjectId> {
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

  async scratchpadRead(sessionId: string): Promise<ScratchpadMemory[]> {
    if (!this._enabled('scratchpad')) return []
    return this.scratchpad
      .find(
        { session_id: sessionId, promoted: false },
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
    if (!this._enabled('scratchpad')) {
      throw new Error('[mongodb-memory] Scratchpad memory is disabled')
    }
    const doc = await this.scratchpad.findOne({ _id: new ObjectId(scratchpadId) })
    if (!doc) throw new Error(`Scratchpad note ${scratchpadId} not found`)

    const episodicId = await this.episodicSave(userId, eventType, doc.note, opts)

    await this.scratchpad.updateOne(
      { _id: doc._id },
      { $set: { promoted: true, promoted_to_id: episodicId } }
    )

    return { episodicId }
  }

  // ─── Agent-driven deletion (memory_forget) ──────────────────────────────────

  /**
   * Mark a document for near-immediate deletion by setting `expire_at` to now.
   * The always-on `{ expire_at: 1 }` TTL index reaps it within ~60s.
   *
   * @returns true if the doc was found and marked, false otherwise.
   */
  async forget(type: MemoryType, id: string): Promise<boolean> {
    if (!this._enabled(type)) {
      throw new Error(`[mongodb-memory] "${type}" memory is disabled`)
    }
    const collection = this._collectionFor(type)
    const result = await collection.updateOne(
      { _id: new ObjectId(id) } as Filter<Record<string, unknown>>,
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
