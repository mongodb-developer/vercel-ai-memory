import { MongoClient } from 'mongodb'
import { EmbeddingAdapter } from '../../src/embeddings'
import { MongoMemoryStore } from '../../src/store'
import { mockEmbedder } from './mock-embedder'

export const ATLAS_URI =
  process.env.MONGODB_URI ??
  'mongodb+srv://adminIUser:adminIUser@ilcluster.wagfu.mongodb.net/agent_memory_vercel'

// Fixed DB name — reused across runs so vector search indexes persist.
// Collections are dropped in teardown to ensure a clean state each run.
export const TEST_DB = 'agent_memory_test'

let _client: MongoClient | null = null
let _store: MongoMemoryStore | null = null
let _bootstrapped = false

export async function getTestClient(): Promise<MongoClient> {
  if (_client) return _client
  _client = new MongoClient(ATLAS_URI, {
    appName: 'devrel-integration-memory-vercel-typescript',
  })
  await _client.connect()
  return _client
}

export async function getTestStore(): Promise<MongoMemoryStore> {
  if (_store) return _store
  const client = await getTestClient()
  const adapter = new EmbeddingAdapter(mockEmbedder)
  _store = new MongoMemoryStore(client, adapter, TEST_DB)
  return _store
}

/**
 * All memory collections managed by the store.
 * Kept in one place so cleanup + bootstrap stay in sync.
 */
const MEMORY_COLLECTIONS = [
  'session_memory',
  'semantic_memory',
  'procedural_memory',
  'episodic_memory',
  'scratchpad_memory',
] as const

/**
 * Drop ALL memory collections in the test database.
 *
 * Why drop (not just deleteMany)?
 * - Previous runs may have left behind TTL/compound indexes with different
 *   names than the current code produces (e.g. legacy `created_at_1` vs the
 *   new `session_ttl`). Re-bootstrapping against those surfaces
 *   `IndexOptionsConflict`. Dropping the whole collection wipes every index,
 *   including Atlas vector search indexes, so bootstrap can recreate them
 *   cleanly.
 *
 * Called once before bootstrap in global-setup to guarantee a clean slate.
 */
export async function dropTestCollections(): Promise<void> {
  const client = await getTestClient()
  const db = client.db(TEST_DB)
  for (const name of MEMORY_COLLECTIONS) {
    try {
      await db.collection(name).drop()
    } catch (e: unknown) {
      // NamespaceNotFound (26) just means the collection didn't exist — fine.
      const code = (e as { code?: number })?.code
      if (code !== 26) {
        const msg = e instanceof Error ? e.message : String(e)
        console.warn(`[test] Could not drop "${name}": ${msg}`)
      }
    }
  }
  console.log(`[test] ✅ Test collections dropped (clean slate)`)
}

/**
 * Bootstrap the store ONCE across all test files.
 * Subsequent calls are no-ops.
 */
export async function bootstrapOnce(): Promise<void> {
  if (_bootstrapped) return
  const store = await getTestStore()
  await store.bootstrap()
  _bootstrapped = true
}

/**
 * Poll Atlas until all three vector search indexes are in READY state.
 * Atlas creates indexes asynchronously — this must be called after bootstrap()
 * before any $vectorSearch queries.
 *
 * @param timeoutMs  Maximum wait time (default 120s)
 * @param pollMs     Poll interval (default 3s)
 */
export async function waitForVectorIndexes(
  timeoutMs = 120_000,
  pollMs = 3_000
): Promise<void> {
  const client = await getTestClient()
  const db = client.db(TEST_DB)

  const collections = ['semantic_memory', 'procedural_memory', 'episodic_memory']
  const indexNames = [
    'semantic_vector_index',
    'procedural_vector_index',
    'episodic_vector_index',
  ]

  console.log(`[test] Waiting for vector indexes to be READY on db: ${TEST_DB}...`)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    let allReady = true

    for (let i = 0; i < collections.length; i++) {
      try {
        const indexes = await db
          .collection(collections[i])
          .listSearchIndexes(indexNames[i])
          .toArray()

        const idx = indexes.find((ix: { name: string; status?: string }) => ix.name === indexNames[i])
        if (!idx || (idx as { name: string; status?: string }).status !== 'READY') {
          allReady = false
          break
        }
      } catch {
        allReady = false
        break
      }
    }

    if (allReady) {
      console.log(`[test] ✅ All vector indexes READY`)
      return
    }

    console.log(`[test] Indexes not ready yet — waiting ${pollMs}ms...`)
    await new Promise((r) => setTimeout(r, pollMs))
  }

  console.warn(`[test] ⚠️  Timed out waiting for vector indexes — proceeding anyway`)
}

/**
 * Drop the test database and close the connection.
 * Call this ONCE after all tests complete (from globalSetup teardown or
 * the last test file's afterAll).
 */
export async function teardown(): Promise<void> {
  if (_client) {
    // Try to clean up test collections individually (more permissive than dropDatabase)
    try {
      const db = _client.db(TEST_DB)
      for (const col of MEMORY_COLLECTIONS) {
        try {
          await db.collection(col).deleteMany({})
        } catch {
          // ignore per-collection cleanup errors
        }
      }
      console.log(`[test] ✅ Test collections cleared`)
    } catch {
      // If even that fails (e.g. no permissions), just skip — Atlas will TTL the data
      console.log(`[test] ⚠️  Could not clear test data — Atlas TTL will clean it up`)
    }
    await _client.close()
    _client = null
    _store = null
    _bootstrapped = false
  }
}

// Keep backward compat alias
export const closeTestClient = teardown
