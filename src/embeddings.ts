import { embed } from 'ai'
import type { EmbeddingModel } from 'ai'

/**
 * Embedding adapter wrapping any Vercel AI SDK EmbeddingModel.
 * Dimensions are auto-detected on the first call and cached.
 */
export class EmbeddingAdapter {
  private model: EmbeddingModel
  private _dimensions: number | null = null

  constructor(model: EmbeddingModel) {
    this.model = model
  }

  /**
   * Embed a single text string.
   * Also caches the detected dimension on first call.
   */
  async embedText(text: string): Promise<number[]> {
    const result = await embed({
      model: this.model,
      value: text,
    })
    if (this._dimensions === null) {
      this._dimensions = result.embedding.length
    }
    return result.embedding
  }

  /**
   * Returns the embedding dimensions, probing if not yet detected.
   * Safe to call before any real embedding — uses a short sentinel string.
   */
  async getDimensions(): Promise<number> {
    if (this._dimensions !== null) return this._dimensions
    await this.embedText('__dim_probe__')
    return this._dimensions!
  }
}
