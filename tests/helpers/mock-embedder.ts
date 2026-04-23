import type { EmbeddingModelV3, EmbeddingModelV3CallOptions } from '@ai-sdk/provider'

/**
 * A deterministic fake EmbeddingModel that returns fixed-length vectors.
 * Used in tests to avoid real API calls while exercising all embedding paths.
 *
 * The vectors are deterministic but unique per input (based on charCode sum),
 * so semantic search results are reproducible.
 */
export function createMockEmbedder(dims = 128): EmbeddingModelV3 {
  return {
    specificationVersion: 'v3',
    provider: 'mock',
    modelId: `mock-${dims}`,
    maxEmbeddingsPerCall: undefined,
    supportsParallelCalls: true,
    doEmbed: async ({ values }: EmbeddingModelV3CallOptions) => ({
      embeddings: values.map((text: string) => {
        // Deterministic: spread a hash of the text across the vector
        const base = Array(dims).fill(0.1) as number[]
        const hash = text.split('').reduce((acc: number, ch: string) => acc + ch.charCodeAt(0), 0)
        base[hash % dims] = 0.9
        return base
      }),
      usage: { tokens: values.reduce((s: number, v: string) => s + v.length, 0) },
      warnings: [],
    }),
  }
}

/** Default 128-dim mock embedder singleton for convenience */
export const mockEmbedder = createMockEmbedder(128)
