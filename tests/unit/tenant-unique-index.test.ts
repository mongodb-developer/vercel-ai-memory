import { describe, it, expect, vi } from 'vitest'
import type { MongoClient } from 'mongodb'
import { MongoMemoryStore } from '../../src/store'
import { EmbeddingAdapter } from '../../src/embeddings'
import { resolveConfig } from '../../src/config'
import { mockEmbedder } from '../helpers/mock-embedder'
import type { MongoDBMemoryOptions } from '../../src/types'

/**
 * #16 — the "one latest version per key" unique index must include the scope
 * fields, or two tenants sharing a user_id + fact name collide (E11000).
 * Found by the Atlas integration test.
 */

function makeStore(topology: MongoDBMemoryOptions['topology'], legacyExists = false) {
  const cols: Record<string, { createIndex: ReturnType<typeof vi.fn>; indexExists: ReturnType<typeof vi.fn> }> = {}
  const db = {
    collection: (name: string) =>
      (cols[name] ??= {
        createIndex: vi.fn().mockResolvedValue('ok'),
        indexExists: vi.fn().mockResolvedValue(legacyExists),
        collectionName: name,
      } as never),
    // listSearchIndexes / createSearchIndexes go through db.command or the
    // aggregate path; we only care about regular indexes here.
    command: vi.fn().mockResolvedValue({ cursor: { firstBatch: [] } }),
  }
  const client = { db: () => db } as unknown as MongoClient
  const config = resolveConfig({
    uri: 'mongodb://stub',
    embedder: mockEmbedder,
    topology: { disable: ['session', 'scratchpad', 'episodic'], ...topology },
  })
  const store = new MongoMemoryStore(client, new EmbeddingAdapter(mockEmbedder), config)
  // Skip the vector-index part of bootstrap; it's covered elsewhere.
  ;(store as unknown as { _createVectorIndex: () => Promise<void> })._createVectorIndex = async () => {}
  return { store, cols }
}

function uniqueIndexCalls(col: { createIndex: ReturnType<typeof vi.fn> }) {
  return col.createIndex.mock.calls.filter(([, opts]) => opts?.unique === true)
}

describe('latest-version unique index', () => {
  it('keeps the original index when no scope fields are configured', async () => {
    const { store, cols } = makeStore({})
    await store.bootstrap()
    expect(uniqueIndexCalls(cols.semantic_memory)).toEqual([
      [{ user_id: 1, name: 1, is_latest: 1 }, expect.objectContaining({ name: 'semantic_latest_unique' })],
    ])
    expect(uniqueIndexCalls(cols.procedural_memory)).toEqual([
      [{ user_id: 1, task: 1, is_latest: 1 }, expect.objectContaining({ name: 'procedural_latest_unique' })],
    ])
  })

  it('creates a scoped unique index that includes tenant_id', async () => {
    const { store, cols } = makeStore({
      extraFilterFields: { semantic: ['tenant_id'], procedural: ['tenant_id'] },
    })
    await store.bootstrap()
    const [[spec, opts]] = uniqueIndexCalls(cols.semantic_memory)
    expect(spec).toEqual({ tenant_id: 1, user_id: 1, name: 1, is_latest: 1 })
    expect(opts).toMatchObject({
      name: 'semantic_latest_unique_scoped',
      partialFilterExpression: { is_latest: true },
    })
    expect(uniqueIndexCalls(cols.procedural_memory)[0][0]).toEqual({
      tenant_id: 1,
      user_id: 1,
      task: 1,
      is_latest: 1,
    })
  })

  it('warns (but never drops) when the legacy unscoped index is still present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { store } = makeStore({ extraFilterFields: { semantic: ['tenant_id'] } }, true)
    await store.bootstrap()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropIndex("semantic_latest_unique")'))
    warn.mockRestore()
  })
})
