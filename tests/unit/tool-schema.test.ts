import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { buildMemoryTool } from '../../src/tool'
import type { MemoryConfig, MemoryType } from '../../src/types'

// Re-create the schema locally to test the static shape independently of
// the tool builder. Mirrors the default (all-enabled) schema in src/tool.ts,
// plus the `memory_forget` command.
const memoryCommandSchema = z.object({
  command: z.enum([
    'session_append',
    'session_recent',
    'semantic_save',
    'semantic_search',
    'procedural_save',
    'procedural_search',
    'episodic_save',
    'episodic_search',
    'scratchpad_write',
    'scratchpad_read',
    'scratchpad_promote',
    'memory_forget',
  ]),
  role: z.enum(['user', 'assistant', 'tool']).nullable().optional(),
  content: z.string().nullable().optional(),
  tool_name: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  task: z.string().nullable().optional(),
  importance: z.number().min(1).max(10).nullable().optional(),
  tags: z.array(z.string()).nullable().optional(),
  source: z.enum(['human_expert', 'agent_learned', 'error_recovery']).nullable().optional(),
  event_type: z.string().nullable().optional(),
  context: z.record(z.unknown()).nullable().optional(),
  query: z.string().nullable().optional(),
  limit: z.number().int().positive().nullable().optional(),
  scratchpad_id: z.string().nullable().optional(),
  memory_type: z.enum(['session', 'semantic', 'procedural', 'episodic', 'scratchpad']).nullable().optional(),
  id: z.string().nullable().optional(),
  reason: z.string().nullable().optional(),
})

describe('Memory tool schema (static shape)', () => {
  it('accepts a minimal session_append command', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'session_append',
      role: 'user',
      content: 'hello',
    })
    expect(result.success).toBe(true)
  })

  it('accepts session_recent with no extra fields', () => {
    const result = memoryCommandSchema.safeParse({ command: 'session_recent' })
    expect(result.success).toBe(true)
  })

  it('accepts semantic_save with all optional fields', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'semantic_save',
      name: 'Alice',
      content: 'Loves hiking',
      importance: 8,
      tags: ['preference', 'outdoor'],
    })
    expect(result.success).toBe(true)
  })

  it('rejects importance outside 1–10', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'semantic_save',
      name: 'Test',
      content: 'Test',
      importance: 11,
    })
    expect(result.success).toBe(false)
  })

  it('rejects importance below 1', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'episodic_save',
      content: 'Test event',
      importance: 0,
    })
    expect(result.success).toBe(false)
  })

  it('accepts procedural_save with source', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'procedural_save',
      task: 'Browse Products',
      content: '1. Open catalog. 2. Filter by category.',
      source: 'human_expert',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid source value', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'procedural_save',
      task: 'Test',
      content: 'Test',
      source: 'unknown_source',
    })
    expect(result.success).toBe(false)
  })

  it('rejects invalid command', () => {
    const result = memoryCommandSchema.safeParse({ command: 'delete_all' })
    expect(result.success).toBe(false)
  })

  it('accepts scratchpad_promote with required fields', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'scratchpad_promote',
      scratchpad_id: '507f1f77bcf86cd799439011',
      event_type: 'interaction',
    })
    expect(result.success).toBe(true)
  })

  it('accepts null for optional nullable fields', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'episodic_save',
      content: 'Something happened',
      importance: null,
      context: null,
    })
    expect(result.success).toBe(true)
  })

  it('accepts memory_forget with memory_type + id', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'memory_forget',
      memory_type: 'semantic',
      id: '507f1f77bcf86cd799439011',
      reason: 'user asked to forget',
    })
    expect(result.success).toBe(true)
  })

  it('rejects invalid memory_type', () => {
    const result = memoryCommandSchema.safeParse({
      command: 'memory_forget',
      memory_type: 'cache',
      id: 'x',
    })
    expect(result.success).toBe(false)
  })
})

// ─── Dynamic schema from buildMemoryTool ─────────────────────────────────────

function makeConfig(disable: MemoryType[] = []): MemoryConfig {
  return {
    dbName: 'x',
    defaultUserId: 'u',
    defaultSessionId: 's',
    collections: {
      session: 'session_memory',
      semantic: 'semantic_memory',
      procedural: 'procedural_memory',
      episodic: 'episodic_memory',
      scratchpad: 'scratchpad_memory',
    },
    vectorIndexNames: {
      semantic: 'semantic_vector_index',
      procedural: 'procedural_vector_index',
      episodic: 'episodic_vector_index',
    },
    disabled: new Set(disable),
    extraFilterFields: { semantic: [], procedural: [], episodic: [] },
    retention: {
      session: { mode: 'ttl', ttlSeconds: 86_400, field: 'created_at' },
      scratchpad: { mode: 'ttl', ttlSeconds: 3_600, field: 'created_at' },
      episodic: { mode: 'ttl', ttlSeconds: 31_536_000, field: 'stats.last_retrieved' },
      semantic: { mode: 'none' },
      procedural: { mode: 'none' },
    },
    filtering: { minImportance: 0, recencyWindowHours: 0, numCandidatesMultiplier: 10 },
    defaults: { importance: 5, sessionRecentLimit: 40, searchLimit: 5, similarity: 'cosine' },
  }
}

describe('buildMemoryTool — dynamic command enum', () => {
  // A minimal store stub; execute() isn't called here, we only inspect the schema.
  const storeStub = {} as unknown as Parameters<typeof buildMemoryTool>[0]

  const getCommandEnum = (tool: ReturnType<typeof buildMemoryTool>): string[] => {
    // zod v3 stores enum values under .options; be defensive across versions.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = tool.inputSchema as any
    const shape = schema.shape ?? schema._def?.shape?.() ?? {}
    const commandSchema = shape.command
    return commandSchema.options ?? commandSchema._def?.values ?? []
  }

  it('exposes all commands by default', () => {
    const t = buildMemoryTool(storeStub, 'u', 's', undefined, makeConfig())
    const cmds = getCommandEnum(t)
    expect(cmds).toContain('session_append')
    expect(cmds).toContain('semantic_save')
    expect(cmds).toContain('procedural_save')
    expect(cmds).toContain('episodic_save')
    expect(cmds).toContain('scratchpad_write')
    expect(cmds).toContain('memory_forget')
  })

  it('omits commands for disabled memory types but keeps memory_forget', () => {
    const t = buildMemoryTool(storeStub, 'u', 's', undefined, makeConfig(['episodic', 'scratchpad']))
    const cmds = getCommandEnum(t)
    expect(cmds).not.toContain('episodic_save')
    expect(cmds).not.toContain('episodic_search')
    expect(cmds).not.toContain('scratchpad_write')
    expect(cmds).not.toContain('scratchpad_read')
    expect(cmds).not.toContain('scratchpad_promote')
    expect(cmds).toContain('semantic_save')
    expect(cmds).toContain('memory_forget')
  })

  it('description reflects disabled memory types', () => {
    const t = buildMemoryTool(storeStub, 'u', 's', undefined, makeConfig(['scratchpad']))
    expect(t.description).not.toContain('Scratchpad')
    expect(t.description).toContain('Semantic')
  })

  it('falls back to legacy behavior when no config is provided', () => {
    const t = buildMemoryTool(storeStub, 'u', 's')
    const cmds = getCommandEnum(t)
    // Legacy path = nothing disabled, memory_forget included
    expect(cmds).toContain('scratchpad_write')
    expect(cmds).toContain('memory_forget')
  })
})

// ─── Executor smoke test: memory_forget routes to store.forget() ──────────────

describe('memory_forget execution', () => {
  it('calls store.forget with memory_type + id and returns success message', async () => {
    const forget = vi.fn().mockResolvedValue(true)
    const store = { forget } as unknown as Parameters<typeof buildMemoryTool>[0]

    const t = buildMemoryTool(store, 'alice', 'sess', undefined, makeConfig())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await (t.execute as any)({
      command: 'memory_forget',
      memory_type: 'semantic',
      id: '507f1f77bcf86cd799439011',
    })

    expect(forget).toHaveBeenCalledWith('semantic', '507f1f77bcf86cd799439011')
    expect(out.output).toMatch(/Memory marked for deletion/)
  })

  it('returns validation error when fields are missing', async () => {
    const forget = vi.fn()
    const store = { forget } as unknown as Parameters<typeof buildMemoryTool>[0]

    const t = buildMemoryTool(store, 'alice', 'sess', undefined, makeConfig())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await (t.execute as any)({ command: 'memory_forget' })

    expect(forget).not.toHaveBeenCalled()
    expect(out.output).toMatch(/memory_type and id are required/)
  })

  it('returns not-found message when store.forget returns false', async () => {
    const forget = vi.fn().mockResolvedValue(false)
    const store = { forget } as unknown as Parameters<typeof buildMemoryTool>[0]

    const t = buildMemoryTool(store, 'alice', 'sess', undefined, makeConfig())
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out: any = await (t.execute as any)({
      command: 'memory_forget',
      memory_type: 'episodic',
      id: '507f1f77bcf86cd799439011',
    })

    expect(out.output).toMatch(/No memory found to forget/)
  })
})
