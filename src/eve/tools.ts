import { z } from 'zod'
import { defineTool } from 'eve/tools'
import type { MemoryOperationContext } from 'eve/memory'
import type { MongoMemoryStore } from '../store'
import type { MemoryType } from '../types'
import { persistExtracted } from './capture'
import type { EveMemoryTiers } from './types'

interface ToolsDeps {
  store: MongoMemoryStore
  tiers: Required<EveMemoryTiers>
  ensureConnected: () => Promise<void>
}

/**
 * Normalize a model-supplied importance onto the store's 1–10 integer scale.
 * LLMs frequently emit confidence-style fractions (e.g. `0.9`); rejecting them
 * costs a wasted tool round-trip, so we scale `0 < x <= 1` → `1..10` and clamp
 * everything else into range. `undefined` stays `undefined` (store default).
 */
export function normalizeImportance(value: number | undefined): number | undefined {
  if (value === undefined || value === null || Number.isNaN(value)) return undefined
  let v = value
  if (v > 0 && v <= 1) v = v * 10
  v = Math.round(v)
  return Math.min(10, Math.max(1, v))
}

/**
 * Build the Eve provider tools record. Eve qualifies these as
 * `<slot>__<tool>` (e.g. `profile__remember`, `profile__forget`) — we do NOT
 * recreate that namespacing here.
 *
 * Every tool closes over the **trusted, locked scope** (`ctx.memory.scope.key`)
 * captured when Eve calls `tools(ctx)`. The model supplies only the memory
 * payload — never the owner/scope — so it cannot redirect a write to another
 * principal.
 */
export function createTools(deps: ToolsDeps) {
  const { store, tiers, ensureConnected } = deps

  return function tools(ctx: MemoryOperationContext): Record<string, unknown> {
    const scope = ctx.memory.scope.key

    const enabledTypes = (
      ['semantic', 'episodic', 'procedural'] as const
    ).filter((t) => tiers[t]) as Array<'semantic' | 'episodic' | 'procedural'>

    const rememberType =
      enabledTypes.length > 0
        ? (z.enum(enabledTypes as [string, ...string[]]).optional())
        : z.enum(['semantic']).optional()

    const remember = defineTool({
      description:
        'Save a durable, long-term memory for the current user so it is ' +
        'available in future sessions. Use for stable preferences, facts, ' +
        'notable events, or reusable procedures. Never save secrets.',
      inputSchema: z.object({
        content: z.string().describe('The memory statement to store.'),
        type: rememberType.describe(
          'Memory tier: "semantic" (facts/preferences), "episodic" (events), ' +
            'or "procedural" (how-to). Defaults to "semantic".'
        ),
        label: z
          .string()
          .optional()
          .describe('Short label / entity name / event type / task title.'),
        importance: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe(
            'Importance 1–10 (10 = critical). Values in 0–1 are treated as a ' +
              'fraction and scaled to 1–10.'
          ),
      }),
      async execute(input: {
        content: string
        type?: 'semantic' | 'episodic' | 'procedural'
        label?: string
        importance?: number
      }) {
        await ensureConnected()
        const type = input.type ?? 'semantic'
        if (!tiers[type]) {
          return { saved: false, reason: `Memory tier "${type}" is disabled.` }
        }
        const label =
          input.label?.trim() ||
          (type === 'episodic'
            ? 'interaction'
            : type === 'procedural'
              ? 'procedure'
              : 'User preference')
        await persistExtracted(store, scope, {
          type,
          label,
          content: input.content,
          importance: normalizeImportance(input.importance),
        })
        return { saved: true, type, label }
      },
    })

    // Runs automatically (no approval), but only inside the locked Eve scope:
    // the store filters on `{ _id, user_id: scope }`, so the model can never
    // forget another principal's memory — it only ever supplies id + tier.
    const forget = defineTool({
      description:
        'Delete a previously remembered memory by its id and tier ' +
        '(e.g. when the user says "forget that" or a memory is wrong). ' +
        'Only memories of the current user can be deleted.',
      inputSchema: z.object({
        id: z.string().describe('The memory document id to forget.'),
        type: z
          .enum(['semantic', 'episodic', 'procedural'])
          .describe('The tier the id belongs to.'),
      }),
      async execute(input: { id: string; type: MemoryType }) {
        await ensureConnected()
        if (!tiers[input.type as keyof typeof tiers]) {
          return { forgotten: false, id: input.id, type: input.type, reason: `Memory tier "${input.type}" is disabled.` }
        }
        const found = await store.forget(scope, input.type, input.id)
        return { forgotten: found, id: input.id, type: input.type }
      },
    })

    return { remember, forget }
  }
}
