import { describe, it, expect, vi } from 'vitest'
import { EmbeddingAdapter } from '../../src/embeddings'
import { createMockEmbedder } from '../helpers/mock-embedder'

describe('EmbeddingAdapter', () => {
  it('embeds text and returns a number array', async () => {
    const adapter = new EmbeddingAdapter(createMockEmbedder(64))
    const vector = await adapter.embedText('hello world')
    expect(Array.isArray(vector)).toBe(true)
    expect(vector).toHaveLength(64)
    expect(typeof vector[0]).toBe('number')
  })

  it('auto-detects dimensions on first call', async () => {
    const adapter = new EmbeddingAdapter(createMockEmbedder(128))
    expect(await adapter.getDimensions()).toBe(128)
  })

  it('caches dimensions — only calls doEmbed once for getDimensions then embedText', async () => {
    const mock = createMockEmbedder(32)
    const spy = vi.spyOn(mock, 'doEmbed')
    const adapter = new EmbeddingAdapter(mock)

    // First call probes dimensions
    await adapter.getDimensions()
    expect(spy).toHaveBeenCalledTimes(1)

    // Second call uses cached value — no extra embed call
    const dims = await adapter.getDimensions()
    expect(dims).toBe(32)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('embedText populates the dimension cache', async () => {
    const mock = createMockEmbedder(256)
    const spy = vi.spyOn(mock, 'doEmbed')
    const adapter = new EmbeddingAdapter(mock)

    await adapter.embedText('first call populates cache')
    // getDimensions now uses cached value — no extra call
    const dims = await adapter.getDimensions()
    expect(dims).toBe(256)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('produces deterministic vectors for the same input', async () => {
    const adapter = new EmbeddingAdapter(createMockEmbedder(64))
    const v1 = await adapter.embedText('deterministic test')
    const v2 = await adapter.embedText('deterministic test')
    expect(v1).toEqual(v2)
  })

  it('produces different vectors for different inputs', async () => {
    const adapter = new EmbeddingAdapter(createMockEmbedder(128))
    const v1 = await adapter.embedText('rock climbing')
    const v2 = await adapter.embedText('coffee brewing')
    expect(v1).not.toEqual(v2)
  })
})
