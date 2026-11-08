import { describe, it, expect, vi } from 'vitest'
import { MongoMemoryStore } from '../../src/store'
import { resolveConfig } from '../../src/config'
import { EmbeddingAdapter } from '../../src/embeddings'
import { mockEmbedder } from '../helpers/mock-embedder'

const URI = 'mongodb://localhost:27017'

// Fake client whose existing search indexes all report `existingType`
// (or no index at all when `existingType` is null).
function makeClient(existingType: 'vector' | 'autoEmbed' | null) {
  const commands: any[] = []
  const collection = () => ({
    createIndex: vi.fn().mockResolvedValue(undefined),
    listSearchIndexes: vi.fn().mockImplementation((name: string) => ({
      toArray: vi.fn().mockResolvedValue(
        existingType
          ? [{ name, latestDefinition: { fields: [{ type: existingType, path: 'x' }] } }]
          : []
      ),
    })),
  })
  const db = {
    collection: vi.fn().mockImplementation(() => collection()),
    command: vi.fn().mockImplementation((cmd: any) => {
      commands.push(cmd)
      return Promise.resolve(undefined)
    }),
  }
  return { client: { db: vi.fn().mockReturnValue(db) } as any, commands }
}

const autoEmbed = { model: 'voyage-4' }

function storeFor(
  ctx: ReturnType<typeof makeClient>,
  mode: 'client' | 'auto',
  recreate?: boolean
) {
  const config = resolveConfig(
    mode === 'client'
      ? { uri: URI, embedder: mockEmbedder, recreateMismatchedIndex: recreate }
      : { uri: URI, autoEmbed, recreateMismatchedIndex: recreate }
  )
  return new MongoMemoryStore(ctx.client, new EmbeddingAdapter(mockEmbedder), config)
}

describe('vector index type mismatch', () => {
  it('match (client/vector): no drop, no throw', async () => {
    const ctx = makeClient('vector')
    await expect(storeFor(ctx, 'client').bootstrap()).resolves.toBeUndefined()
    expect(ctx.commands.some((c) => c.dropSearchIndex)).toBe(false)
    expect(ctx.commands.some((c) => c.createSearchIndexes)).toBe(false)
  })

  it('match (autoEmbed): no drop, no throw', async () => {
    const ctx = makeClient('autoEmbed')
    await expect(storeFor(ctx, 'auto').bootstrap()).resolves.toBeUndefined()
    expect(ctx.commands.some((c) => c.dropSearchIndex)).toBe(false)
  })

  it('mismatch without opt-in: throws actionable error and never drops', async () => {
    const ctx = makeClient('vector')
    const err = await storeFor(ctx, 'auto').bootstrap().then(
      () => null,
      (e: Error) => e
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('semantic_memory') // collection
    expect(err!.message).toMatch(/Vector index "[^"]+"/) // index name
    expect(err!.message).toContain('type "vector"') // existing
    expect(err!.message).toContain('"autoEmbed" mode') // desired
    expect(err!.message).toContain('recreateMismatchedIndex')
    expect(err!.message).toContain('#switching-embedding-modes')
    expect(ctx.commands.some((c) => c.dropSearchIndex)).toBe(false)
    expect(ctx.commands.some((c) => c.createSearchIndexes)).toBe(false)
  })

  it('mismatch in the other direction also throws without dropping', async () => {
    const ctx = makeClient('autoEmbed')
    await expect(storeFor(ctx, 'client').bootstrap()).rejects.toThrow(/type "autoEmbed"/)
    expect(ctx.commands.some((c) => c.dropSearchIndex)).toBe(false)
  })

  it('mismatch with opt-in: warns, drops and recreates', async () => {
    const ctx = makeClient('vector')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(storeFor(ctx, 'auto', true).bootstrap()).resolves.toBeUndefined()
    const drops = ctx.commands.filter((c) => c.dropSearchIndex)
    const creates = ctx.commands.filter((c) => c.createSearchIndexes)
    expect(drops.length).toBeGreaterThan(0)
    expect(creates.length).toBe(drops.length)
    expect(creates[0].indexes[0].definition.fields[0].type).toBe('autoEmbed')
    expect(warn.mock.calls.flat().join(' ')).toContain('recreateMismatchedIndex: true')
    warn.mockRestore()
  })

  it('no existing index: creates without dropping', async () => {
    const ctx = makeClient(null)
    await storeFor(ctx, 'client').bootstrap()
    expect(ctx.commands.some((c) => c.dropSearchIndex)).toBe(false)
    expect(ctx.commands.some((c) => c.createSearchIndexes)).toBe(true)
  })
})
