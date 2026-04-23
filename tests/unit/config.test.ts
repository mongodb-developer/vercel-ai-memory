import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { resolveConfig } from '../../src/config'
import type { MongoDBMemoryOptions } from '../../src/types'
import { mockEmbedder } from '../helpers/mock-embedder'

const minimal: MongoDBMemoryOptions = {
  uri: 'mongodb://localhost:27017/test',
  embedder: mockEmbedder,
}

describe('resolveConfig — defaults', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('uses agent_memory as default db name', () => {
    const cfg = resolveConfig(minimal)
    expect(cfg.dbName).toBe('agent_memory')
  })

  it('applies default collection names', () => {
    const cfg = resolveConfig(minimal)
    expect(cfg.collections.session).toBe('session_memory')
    expect(cfg.collections.semantic).toBe('semantic_memory')
    expect(cfg.collections.procedural).toBe('procedural_memory')
    expect(cfg.collections.episodic).toBe('episodic_memory')
    expect(cfg.collections.scratchpad).toBe('scratchpad_memory')
  })

  it('applies default vector index names', () => {
    const cfg = resolveConfig(minimal)
    expect(cfg.vectorIndexNames.semantic).toBe('semantic_vector_index')
    expect(cfg.vectorIndexNames.procedural).toBe('procedural_vector_index')
    expect(cfg.vectorIndexNames.episodic).toBe('episodic_vector_index')
  })

  it('defaults: no types disabled, no extra filter fields', () => {
    const cfg = resolveConfig(minimal)
    expect(cfg.disabled.size).toBe(0)
    expect(cfg.extraFilterFields.semantic).toEqual([])
    expect(cfg.extraFilterFields.procedural).toEqual([])
    expect(cfg.extraFilterFields.episodic).toEqual([])
  })

  it('applies default retention policies (mirror original hardcoded)', () => {
    const cfg = resolveConfig(minimal)
    expect(cfg.retention.session).toMatchObject({ mode: 'ttl', ttlSeconds: 86_400 })
    expect(cfg.retention.scratchpad).toMatchObject({ mode: 'ttl', ttlSeconds: 3_600 })
    expect(cfg.retention.episodic).toMatchObject({
      mode: 'ttl',
      ttlSeconds: 31_536_000,
      field: 'stats.last_retrieved',
    })
    expect(cfg.retention.semantic).toEqual({ mode: 'none' })
    expect(cfg.retention.procedural).toEqual({ mode: 'none' })
  })

  it('applies default filtering + defaults', () => {
    const cfg = resolveConfig(minimal)
    expect(cfg.filtering).toEqual({
      minImportance: 0,
      recencyWindowHours: 0,
      numCandidatesMultiplier: 10,
    })
    expect(cfg.defaults).toEqual({
      importance: 5,
      sessionRecentLimit: 40,
      searchLimit: 5,
      similarity: 'cosine',
    })
  })
})

describe('resolveConfig — overrides', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('topology.dbName takes precedence over legacy dbName', () => {
    const cfg = resolveConfig({
      ...minimal,
      dbName: 'legacy_db',
      topology: { dbName: 'new_db' },
    })
    expect(cfg.dbName).toBe('new_db')
  })

  it('legacy dbName still works when topology is absent', () => {
    const cfg = resolveConfig({ ...minimal, dbName: 'legacy_db' })
    expect(cfg.dbName).toBe('legacy_db')
  })

  it('disables memory types and warns', () => {
    const cfg = resolveConfig({
      ...minimal,
      topology: { disable: ['episodic', 'scratchpad'] },
    })
    expect(cfg.disabled.has('episodic')).toBe(true)
    expect(cfg.disabled.has('scratchpad')).toBe(true)
    expect(cfg.disabled.has('session')).toBe(false)
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('allows custom collection and vector-index names', () => {
    const cfg = resolveConfig({
      ...minimal,
      topology: {
        collections: { semantic: 'my_semantic', episodic: 'my_episodic' },
        vectorIndexNames: { semantic: 'my_semantic_idx' },
      },
    })
    expect(cfg.collections.semantic).toBe('my_semantic')
    expect(cfg.collections.episodic).toBe('my_episodic')
    expect(cfg.collections.procedural).toBe('procedural_memory') // unchanged
    expect(cfg.vectorIndexNames.semantic).toBe('my_semantic_idx')
    expect(cfg.vectorIndexNames.episodic).toBe('episodic_vector_index') // unchanged
  })

  it('allows extra filter fields per vector memory type', () => {
    const cfg = resolveConfig({
      ...minimal,
      topology: {
        extraFilterFields: { semantic: ['tenant_id'], episodic: ['region'] },
      },
    })
    expect(cfg.extraFilterFields.semantic).toEqual(['tenant_id'])
    expect(cfg.extraFilterFields.episodic).toEqual(['region'])
    expect(cfg.extraFilterFields.procedural).toEqual([])
  })

  it('applies custom retention policies', () => {
    const cfg = resolveConfig({
      ...minimal,
      retention: {
        semantic: { mode: 'ttl+importance', ttlSeconds: 604_800, minImportance: 7 },
        episodic: { mode: 'none' },
      },
    })
    expect(cfg.retention.semantic).toEqual({
      mode: 'ttl+importance',
      ttlSeconds: 604_800,
      minImportance: 7,
    })
    expect(cfg.retention.episodic).toEqual({ mode: 'none' })
    // Unspecified → defaults preserved
    expect(cfg.retention.scratchpad).toMatchObject({ mode: 'ttl', ttlSeconds: 3_600 })
  })

  it('applies dynamic retention policy with computeExpireAt', () => {
    const computeExpireAt = (_: unknown) => new Date('2030-01-01')
    const cfg = resolveConfig({
      ...minimal,
      retention: {
        episodic: { mode: 'dynamic', computeExpireAt },
      },
    })
    expect(cfg.retention.episodic.mode).toBe('dynamic')
    if (cfg.retention.episodic.mode === 'dynamic') {
      expect(cfg.retention.episodic.computeExpireAt).toBe(computeExpireAt)
    }
  })

  it('applies custom filtering + defaults', () => {
    const cfg = resolveConfig({
      ...minimal,
      filtering: { minImportance: 6, recencyWindowHours: 72, numCandidatesMultiplier: 25 },
      defaults: { importance: 8, searchLimit: 10, sessionRecentLimit: 20, similarity: 'dotProduct' },
    })
    expect(cfg.filtering).toEqual({
      minImportance: 6,
      recencyWindowHours: 72,
      numCandidatesMultiplier: 25,
    })
    expect(cfg.defaults).toEqual({
      importance: 8,
      searchLimit: 10,
      sessionRecentLimit: 20,
      similarity: 'dotProduct',
    })
  })
})

describe('resolveConfig — validation', () => {
  let warn: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    warn.mockRestore()
  })

  it('requires uri', () => {
    expect(() =>
      resolveConfig({ uri: '', embedder: mockEmbedder })
    ).toThrowError(/`uri` is required/)
  })

  it('requires embedder', () => {
    expect(() =>
      // @ts-expect-error — deliberate
      resolveConfig({ uri: 'mongodb://x', embedder: undefined })
    ).toThrowError(/`embedder` is required/)
  })

  it('rejects non-positive ttlSeconds', () => {
    expect(() =>
      resolveConfig({
        ...minimal,
        retention: { session: { mode: 'ttl', ttlSeconds: 0 } },
      })
    ).toThrowError(/ttlSeconds must be a positive number/)
  })

  it('rejects minImportance out of 1–10 in ttl+importance', () => {
    expect(() =>
      resolveConfig({
        ...minimal,
        retention: {
          semantic: { mode: 'ttl+importance', ttlSeconds: 100, minImportance: 0 },
        },
      })
    ).toThrowError(/minImportance must be between 1 and 10/)
  })

  it('rejects dynamic policy without computeExpireAt', () => {
    expect(() =>
      resolveConfig({
        ...minimal,
        retention: {
          // @ts-expect-error — deliberate
          episodic: { mode: 'dynamic' },
        },
      })
    ).toThrowError(/computeExpireAt must be a function/)
  })

  it('rejects defaults.importance out of 1–10', () => {
    expect(() =>
      resolveConfig({ ...minimal, defaults: { importance: 0 } })
    ).toThrowError(/defaults\.importance must be between 1 and 10/)

    expect(() =>
      resolveConfig({ ...minimal, defaults: { importance: 11 } })
    ).toThrowError(/defaults\.importance must be between 1 and 10/)
  })

  it('rejects non-positive search / session limits', () => {
    expect(() =>
      resolveConfig({ ...minimal, defaults: { searchLimit: 0 } })
    ).toThrowError(/searchLimit must be positive/)
    expect(() =>
      resolveConfig({ ...minimal, defaults: { sessionRecentLimit: -1 } })
    ).toThrowError(/sessionRecentLimit must be positive/)
  })

  it('rejects unknown similarity', () => {
    expect(() =>
      // @ts-expect-error — deliberate
      resolveConfig({ ...minimal, defaults: { similarity: 'hamming' } })
    ).toThrowError(/similarity must be one of/)
  })
})
