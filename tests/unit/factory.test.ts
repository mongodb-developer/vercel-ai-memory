import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMongoDBMemory } from '../../src/index'
import { mockEmbedder } from '../helpers/mock-embedder'
import { ATLAS_URI } from '../helpers/atlas-client'

// We mock the MongoClient so this unit test doesn't hit the network.
// Must use a regular function (not arrow) so it works as a constructor with `new`.
vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>()

  const mockCollection = () => ({
    createIndex: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    insertOne: vi.fn().mockResolvedValue({ insertedId: 'mock-id' }),
    aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    updateMany: vi.fn().mockResolvedValue(undefined),
  })

  const mockDb = () => ({
    collection: vi.fn().mockImplementation(() => mockCollection()),
    command: vi.fn().mockResolvedValue(undefined),
  })

  // Use a proper constructor function so `new MongoClient()` works
  function MockMongoClient() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      db: vi.fn().mockImplementation(() => mockDb()),
    }
  }

  return {
    ...actual,
    MongoClient: MockMongoClient,
  }
})

describe('createMongoDBMemory factory', () => {
  let memory: ReturnType<typeof createMongoDBMemory>

  beforeEach(() => {
    memory = createMongoDBMemory({
      uri: ATLAS_URI,
      embedder: mockEmbedder,
    })
  })

  afterEach(async () => {
    await memory.close()
  })

  it('returns a callable function', () => {
    expect(typeof memory).toBe('function')
  })

  it('callable returns { memory: tool } record', () => {
    const tools = memory({ userId: 'alice', sessionId: 'sess-001' })
    expect(tools).toHaveProperty('memory')
    expect(typeof tools.memory).toBe('object')
  })

  it('returns a tool with a description', () => {
    const tools = memory({ userId: 'alice', sessionId: 'sess-001' })
    expect(tools.memory.description).toBeTruthy()
    expect(typeof tools.memory.description).toBe('string')
  })

  it('returns a tool with an inputSchema', () => {
    const tools = memory({ userId: 'alice', sessionId: 'sess-001' })
    expect(tools.memory.inputSchema).toBeTruthy()
  })

  it('has .store property', () => {
    expect(memory.store).toBeTruthy()
    expect(typeof memory.store).toBe('object')
  })

  it('has .connect() method', () => {
    expect(typeof memory.connect).toBe('function')
  })

  it('has .close() method', () => {
    expect(typeof memory.close).toBe('function')
  })

  it('uses default userId/sessionId when not provided', () => {
    const tools = memory()  // no options
    expect(tools).toHaveProperty('memory')
  })

  it('different calls with different userId produce distinct tool instances', () => {
    const toolsAlice = memory({ userId: 'alice', sessionId: 'sess-001' })
    const toolsBob = memory({ userId: 'bob', sessionId: 'sess-002' })
    // They are different object instances
    expect(toolsAlice.memory).not.toBe(toolsBob.memory)
  })

  it('respects default userId set at creation time', () => {
    const memWithDefaults = createMongoDBMemory({
      uri: ATLAS_URI,
      embedder: mockEmbedder,
      userId: 'default-user',
      sessionId: 'default-session',
    })
    const tools = memWithDefaults()  // uses defaults
    expect(tools).toHaveProperty('memory')
  })
})
