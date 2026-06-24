import { describe, it, expect, vi, afterEach } from 'vitest'
import { version } from '../../package.json'

// ── Shared mock state captured before module imports ───────────────────────
let capturedCtorArgs: unknown[][] = []
const appendMetadataMock = vi.fn()

vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>()

  const mockDb = () => ({
    collection: vi.fn().mockReturnValue({
      createIndex: vi.fn().mockResolvedValue(undefined),
    }),
    command: vi.fn().mockResolvedValue(undefined),
  })

  function MockMongoClient(this: unknown, ...args: unknown[]) {
    capturedCtorArgs.push(args)
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      db: vi.fn().mockImplementation(() => mockDb()),
      appendMetadata: appendMetadataMock,
    }
  }

  return { ...actual, MongoClient: MockMongoClient }
})

// Import after mock is registered
import { createMongoDBMemory } from '../../src/index'
import { MongoMemoryStore } from '../../src/store'
import { EmbeddingAdapter } from '../../src/embeddings'
import { mockEmbedder } from '../helpers/mock-embedder'

const TEST_URI = 'mongodb://localhost:27017'

afterEach(() => {
  capturedCtorArgs = []
  appendMetadataMock.mockClear()
})

describe('MongoDB driver handshake metadata', () => {
  describe('createMongoDBMemory (Pattern A — library constructs client)', () => {
    it('passes driverInfo.name "vercel-ai-memory" to MongoClient constructor', async () => {
      const memory = createMongoDBMemory({ uri: TEST_URI, embedder: mockEmbedder })
      await memory.close()

      expect(capturedCtorArgs).toHaveLength(1)
      const opts = capturedCtorArgs[0]?.[1] as Record<string, unknown>
      expect(opts?.driverInfo).toMatchObject({ name: 'vercel-ai-memory' })
    })

    it('passes driverInfo.version matching the package version', async () => {
      const memory = createMongoDBMemory({ uri: TEST_URI, embedder: mockEmbedder })
      await memory.close()

      const opts = capturedCtorArgs[0]?.[1] as Record<string, unknown>
      expect(opts?.driverInfo).toMatchObject({ version })
    })

    it('preserves appName alongside driverInfo', async () => {
      const memory = createMongoDBMemory({ uri: TEST_URI, embedder: mockEmbedder })
      await memory.close()

      const opts = capturedCtorArgs[0]?.[1] as Record<string, unknown>
      expect(opts?.appName).toBe('devrel-integration-memory-vercel-typescript')
      expect(opts?.driverInfo).toBeTruthy()
    })
  })

  describe('MongoMemoryStore constructor (Pattern B — caller-supplied client)', () => {
    it('calls appendMetadata with driverInfo when the client supports it', () => {
      const mockClient = {
        db: vi.fn().mockReturnValue({
          collection: vi.fn().mockReturnValue({}),
        }),
        appendMetadata: appendMetadataMock,
      } as unknown as import('mongodb').MongoClient

      new MongoMemoryStore(mockClient, new EmbeddingAdapter(mockEmbedder), 'testdb')

      expect(appendMetadataMock).toHaveBeenCalledOnce()
      expect(appendMetadataMock).toHaveBeenCalledWith({ name: 'vercel-ai-memory', version })
    })

    it('does not throw when the client lacks appendMetadata (older driver)', () => {
      const clientWithoutAppend = {
        db: vi.fn().mockReturnValue({
          collection: vi.fn().mockReturnValue({}),
        }),
      } as unknown as import('mongodb').MongoClient

      expect(
        () => new MongoMemoryStore(clientWithoutAppend, new EmbeddingAdapter(mockEmbedder), 'testdb'),
      ).not.toThrow()
    })
  })
})
