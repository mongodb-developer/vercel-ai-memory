import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockEmbedder } from '../../helpers/mock-embedder'

// ── Mock the optional `eve` peer dependency ─────────────────────────────────
// `eve` is not installed (it's an optional peer dep). We mock the small surface
// the adapter uses: defineMemoryProvider returns its definition unchanged, and
// defineTool returns the def so we can invoke `execute` directly in tests.
vi.mock('eve/memory', () => ({
  defineMemoryProvider: (def: unknown) => def,
  defineMemory: (def: unknown) => def,
}))
vi.mock('eve/tools', () => ({
  defineTool: (def: unknown) => def,
  disableTool: () => ({ disabled: true }),
}))
vi.mock('eve/memory/scope', () => ({
  byPrincipal: () => 'principal-key',
}))

// ── Mock mongodb so no network is required ──────────────────────────────────
vi.mock('mongodb', async (importOriginal) => {
  const actual = await importOriginal<typeof import('mongodb')>()
  const mockCollection = () => ({
    createIndex: vi.fn().mockResolvedValue(undefined),
    updateOne: vi.fn().mockResolvedValue(undefined),
    updateMany: vi.fn().mockResolvedValue(undefined),
    findOne: vi.fn().mockResolvedValue(null),
    find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    insertOne: vi.fn().mockResolvedValue({ insertedId: 'mock-id' }),
    insertMany: vi.fn().mockResolvedValue(undefined),
    aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
  })
  const mockDb = () => ({
    collection: vi.fn().mockImplementation(() => mockCollection()),
    command: vi.fn().mockResolvedValue(undefined),
  })
  function MockMongoClient() {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      db: vi.fn().mockImplementation(() => mockDb()),
    }
  }
  return { ...actual, MongoClient: MockMongoClient }
})

// Import AFTER mocks are registered.
import { mongodbMemory, mongodb } from '../../../src/eve'
import { MongoMemoryStore } from '../../../src/store'

const TEST_URI = 'mongodb://localhost:27017'

function makeCtx(scopeKey: string, input = 'prepare my next meeting') {
  return {
    memory: { scope: { key: scopeKey, namespace: 'ns', value: scopeKey } },
    turn: { id: 't1', sequence: 0, input: [{ role: 'user', content: input }] },
    operationId: `op-${scopeKey}`,
  }
}

describe('/eve adapter — imports & shape', () => {
  it('#2 can be imported independently (mongodbMemory + mongodb alias)', () => {
    expect(typeof mongodbMemory).toBe('function')
    expect(typeof mongodb).toBe('function')
    expect(mongodb).toBe(mongodbMemory)
  })

  it('builds a provider with recall + tools (automatic capture by default)', () => {
    const provider = mongodbMemory({ uri: TEST_URI, embedder: mockEmbedder }) as any
    expect(typeof provider.recall['turn.started']).toBe('function')
    expect(typeof provider.tools).toBe('function')
    expect(typeof provider.capture['turn.completed']).toBe('function')
  })

  it('capture:"agent" exposes tools but no capture handler', () => {
    const provider = mongodbMemory({
      uri: TEST_URI,
      embedder: mockEmbedder,
      capture: 'agent',
    }) as any
    expect(provider.capture).toBeUndefined()
    expect(typeof provider.tools).toBe('function')
  })

  it('capture:false registers no capture handler', () => {
    const provider = mongodbMemory({
      uri: TEST_URI,
      embedder: mockEmbedder,
      capture: false,
    }) as any
    expect(provider.capture).toBeUndefined()
  })
})

describe('/eve adapter — scope partitioning (#3)', () => {
  let searchSpies: Array<ReturnType<typeof vi.spyOn>>

  beforeEach(() => {
    searchSpies = [
      vi.spyOn(MongoMemoryStore.prototype, 'semanticSearch').mockResolvedValue([]),
      vi.spyOn(MongoMemoryStore.prototype, 'episodicSearch').mockResolvedValue([]),
      vi.spyOn(MongoMemoryStore.prototype, 'proceduralSearch').mockResolvedValue([]),
      vi.spyOn(MongoMemoryStore.prototype, 'bootstrap').mockResolvedValue(undefined),
    ]
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('every recall read uses ctx.memory.scope.key as the userId', async () => {
    const provider = mongodbMemory({ uri: TEST_URI, embedder: mockEmbedder }) as any
    await provider.recall['turn.started'](makeCtx('scope-A', 'what do you know'))

    for (const spy of searchSpies.slice(0, 3)) {
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][0]).toBe('scope-A')
    }
  })

  it('recall returns no reads for empty query', async () => {
    const provider = mongodbMemory({ uri: TEST_URI, embedder: mockEmbedder }) as any
    const res = await provider.recall['turn.started'](makeCtx('scope-A', '   '))
    expect(res.messages).toEqual([])
    expect(searchSpies[0]).not.toHaveBeenCalled()
  })

  it('two principals do not read each other (distinct scope keys) (#5/#6)', async () => {
    const provider = mongodbMemory({ uri: TEST_URI, embedder: mockEmbedder }) as any
    await provider.recall['turn.started'](makeCtx('alice'))
    await provider.recall['turn.started'](makeCtx('bob'))

    const semanticCalls = searchSpies[0].mock.calls.map((c) => c[0])
    expect(semanticCalls).toEqual(['alice', 'bob'])
    expect(new Set(semanticCalls).size).toBe(2)
  })
})

describe('/eve adapter — tools (#7 remember, #8 forget)', () => {
  let semanticSave: ReturnType<typeof vi.spyOn>
  let episodicSave: ReturnType<typeof vi.spyOn>
  let proceduralSave: ReturnType<typeof vi.spyOn>
  let forget: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.spyOn(MongoMemoryStore.prototype, 'bootstrap').mockResolvedValue(undefined)
    semanticSave = vi.spyOn(MongoMemoryStore.prototype, 'semanticSave').mockResolvedValue(undefined)
    episodicSave = vi
      .spyOn(MongoMemoryStore.prototype, 'episodicSave')
      .mockResolvedValue(undefined as any)
    proceduralSave = vi
      .spyOn(MongoMemoryStore.prototype, 'proceduralSave')
      .mockResolvedValue(undefined)
    forget = vi.spyOn(MongoMemoryStore.prototype, 'forget').mockResolvedValue(true)
  })
  afterEach(() => vi.restoreAllMocks())

  it('remember tool writes with the trusted scope, not model input', async () => {
    const provider = mongodbMemory({ uri: TEST_URI, embedder: mockEmbedder }) as any
    const toolset = provider.tools(makeCtx('tenant-1'))
    await toolset.remember.execute({ content: 'Prefers dark mode', type: 'semantic' })

    expect(semanticSave).toHaveBeenCalledTimes(1)
    expect(semanticSave.mock.calls[0][0]).toBe('tenant-1')
    expect(semanticSave.mock.calls[0][2]).toBe('Prefers dark mode')
  })

  it('remember routes episodic and procedural correctly', async () => {
    const provider = mongodbMemory({ uri: TEST_URI, embedder: mockEmbedder }) as any
    const toolset = provider.tools(makeCtx('tenant-1'))
    await toolset.remember.execute({ content: 'Closed the Acme deal', type: 'episodic' })
    await toolset.remember.execute({ content: 'Always CC legal', type: 'procedural' })
    expect(episodicSave.mock.calls[0][0]).toBe('tenant-1')
    expect(proceduralSave.mock.calls[0][0]).toBe('tenant-1')
  })

  it('forget tool deletes by id+type, scoped to the trusted scope key', async () => {
    const provider = mongodbMemory({ uri: TEST_URI, embedder: mockEmbedder }) as any
    const toolset = provider.tools(makeCtx('tenant-1'))
    const out = await toolset.forget.execute({ id: 'abc123', type: 'semantic' })
    expect(forget).toHaveBeenCalledWith('tenant-1', 'semantic', 'abc123')
    expect(out).toMatchObject({ forgotten: true, id: 'abc123', type: 'semantic' })
  })

  it('forget tools bound to different scopes never cross principals', async () => {
    const provider = mongodbMemory({ uri: TEST_URI, embedder: mockEmbedder }) as any
    await provider.tools(makeCtx('alice')).forget.execute({ id: 'x1', type: 'episodic' })
    await provider.tools(makeCtx('bob')).forget.execute({ id: 'x1', type: 'episodic' })
    expect(forget.mock.calls.map((c) => c[0])).toEqual(['alice', 'bob'])
  })

  it('forget on a disabled tier does not touch the store', async () => {
    const provider = mongodbMemory({
      uri: TEST_URI,
      embedder: mockEmbedder,
      memory: { procedural: false },
    }) as any
    const out = await provider.tools(makeCtx('tenant-1')).forget.execute({ id: 'x', type: 'procedural' })
    expect(forget).not.toHaveBeenCalled()
    expect(out).toMatchObject({ forgotten: false })
  })
})

