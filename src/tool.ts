import { tool } from 'ai'
import { z } from 'zod'
import type { MongoMemoryStore } from './store'
import type { MemoryConfig, MemoryType } from './types'

// ─── Command catalog ──────────────────────────────────────────────────────────

/** Every command the tool can expose, grouped by the memory type it belongs to. */
const COMMANDS_BY_TYPE: Record<MemoryType, string[]> = {
  session: ['session_append', 'session_recent'],
  semantic: ['semantic_save', 'semantic_search'],
  procedural: ['procedural_save', 'procedural_search'],
  episodic: ['episodic_save', 'episodic_search'],
  scratchpad: ['scratchpad_write', 'scratchpad_read', 'scratchpad_promote'],
}

/** The agent-forget command is always available (works across all enabled types). */
const FORGET_COMMAND = 'memory_forget'

/** Build the allowed command list for the given config. */
function enabledCommands(disabled: Set<MemoryType>): string[] {
  const cmds: string[] = []
  ;(Object.keys(COMMANDS_BY_TYPE) as MemoryType[]).forEach((type) => {
    if (!disabled.has(type)) cmds.push(...COMMANDS_BY_TYPE[type])
  })
  cmds.push(FORGET_COMMAND)
  return cmds
}

// ─── Zod schema factory ───────────────────────────────────────────────────────
// Flat schema — avoids discriminatedUnion issues with some LLM providers.
// The `command` enum is built dynamically from the enabled memory types.

function buildSchema(disabled: Set<MemoryType>) {
  const cmds = enabledCommands(disabled) as [string, ...string[]]

  return z.object({
    command: z.enum(cmds).describe('The memory operation to perform.'),

    // ── session_append ──────────────────────────────────────────────────────
    role: z
      .enum(['user', 'assistant', 'tool'])
      .nullable()
      .optional()
      .describe('For session_append: the role of the message.'),
    content: z
      .string()
      .nullable()
      .optional()
      .describe(
        'For session_append, semantic_save, procedural_save, episodic_save, scratchpad_write: the text content.'
      ),
    tool_name: z
      .string()
      .nullable()
      .optional()
      .describe('For session_append when role=tool: the tool name.'),

    // ── semantic_save / procedural_save ─────────────────────────────────────
    name: z
      .string()
      .nullable()
      .optional()
      .describe('For semantic_save: entity name (e.g. "Alice", "User Preference").'),
    task: z
      .string()
      .nullable()
      .optional()
      .describe('For procedural_save: short task label (e.g. "Browse Products").'),
    importance: z
      .number()
      .min(1)
      .max(10)
      .nullable()
      .optional()
      .describe('Importance score 1–10 for semantic_save, procedural_save, episodic_save.'),
    tags: z
      .array(z.string())
      .nullable()
      .optional()
      .describe('For semantic_save: optional tag list.'),
    source: z
      .enum(['human_expert', 'agent_learned', 'error_recovery'])
      .nullable()
      .optional()
      .describe('For procedural_save: knowledge source.'),

    // ── episodic_save ───────────────────────────────────────────────────────
    event_type: z
      .string()
      .nullable()
      .optional()
      .describe(
        'For episodic_save and scratchpad_promote: event type (e.g. "interaction", "purchase").'
      ),
    context: z
      .record(z.string(), z.unknown())
      .nullable()
      .optional()
      .describe('For episodic_save and scratchpad_promote: free-form event metadata.'),

    // ── search ──────────────────────────────────────────────────────────────
    query: z
      .string()
      .nullable()
      .optional()
      .describe('For semantic_search, procedural_search, episodic_search: the search query.'),
    limit: z
      .number()
      .int()
      .positive()
      .nullable()
      .optional()
      .describe('Optional result limit for search and session_recent commands.'),

    // ── scratchpad_promote ──────────────────────────────────────────────────
    scratchpad_id: z
      .string()
      .nullable()
      .optional()
      .describe('For scratchpad_promote: the _id string of the scratchpad note to promote.'),

    // ── memory_forget ───────────────────────────────────────────────────────
    memory_type: z
      .enum(['session', 'semantic', 'procedural', 'episodic', 'scratchpad'])
      .nullable()
      .optional()
      .describe('For memory_forget: which memory type the id belongs to.'),
    id: z
      .string()
      .nullable()
      .optional()
      .describe('For memory_forget: the _id string of the memory doc to forget.'),
    reason: z
      .string()
      .nullable()
      .optional()
      .describe('For memory_forget: optional rationale (audit only, not persisted).'),
  })
}

// ─── Tool description builder ─────────────────────────────────────────────────

function buildDescription(disabled: Set<MemoryType>): string {
  const sections: string[] = []

  sections.push(`Persistent long-term memory backed by MongoDB Atlas Vector Search.

Memory types:`)

  if (!disabled.has('session'))
    sections.push('- Session Memory  : per-session conversation turns')
  if (!disabled.has('semantic'))
    sections.push('- Semantic Memory : knowledge about people, entities, preferences (versioned)')
  if (!disabled.has('procedural'))
    sections.push('- Procedural Memory: how-to instructions and workflows (versioned)')
  if (!disabled.has('episodic'))
    sections.push('- Episodic Memory : events, outcomes, interactions')
  if (!disabled.has('scratchpad'))
    sections.push('- Scratchpad      : temporary notes; can be promoted to Episodic')

  sections.push(`
Commands:`)
  if (!disabled.has('session')) {
    sections.push('  session_append {role, content, tool_name?}       → Save a conversation turn')
    sections.push('  session_recent {limit?}                          → Get recent session turns')
  }
  if (!disabled.has('semantic')) {
    sections.push('  semantic_save {name, content, importance?, tags?}   → Save/update entity knowledge')
    sections.push('  semantic_search {query, limit?}                  → Semantic search over knowledge')
  }
  if (!disabled.has('procedural')) {
    sections.push('  procedural_save {task, content, importance?, source?} → Save/update a procedure')
    sections.push('  procedural_search {query, limit?}                → Semantic search over procedures')
  }
  if (!disabled.has('episodic')) {
    sections.push('  episodic_save {event_type, content, importance?, context?} → Record an event')
    sections.push('  episodic_search {query, limit?}                  → Semantic search over events')
  }
  if (!disabled.has('scratchpad')) {
    sections.push('  scratchpad_write {content}                       → Write a temporary note')
    sections.push('  scratchpad_read                                  → Read current session notes')
    sections.push('  scratchpad_promote {scratchpad_id, event_type}   → Promote note to Episodic memory')
  }
  sections.push('  memory_forget {memory_type, id, reason?}         → Mark a memory doc for deletion')

  sections.push(`
Rules:
- At the start of each session, call session_recent to restore context.
- Save important user facts with semantic_save.
- Save how-to knowledge with procedural_save.
- Record significant events with episodic_save.
- Use scratchpad for temporary working notes during a task.
- Use memory_forget when the user says "forget that" or a memory is clearly wrong.
- Never expose memory operations in your replies to the user.`)

  return sections.join('\n')
}

// ─── Tool builder ─────────────────────────────────────────────────────────────

/**
 * Builds the AI SDK memory tool scoped to a specific userId + sessionId.
 *
 * @param store            The backing MongoMemoryStore.
 * @param userId           Bound userId for all operations.
 * @param sessionId        Bound sessionId for session/scratchpad operations.
 * @param onBeforeExecute  Optional async hook called before every execute (e.g. lazy bootstrap).
 * @param config           Optional resolved MemoryConfig — used to tailor the command enum
 *                         and description to the disabled memory types. If omitted, all
 *                         commands are exposed (legacy behavior).
 */
export function buildMemoryTool(
  store: MongoMemoryStore,
  userId: string,
  sessionId: string,
  onBeforeExecute?: () => Promise<void>,
  config?: MemoryConfig
) {
  // Commands are hidden from the tool when the type is either fully disabled
  // OR when the caller asked to hide-but-keep-live (hookdriven session, etc.).
  const hidden = config?.hiddenFromTool ?? config?.disabled ?? new Set<MemoryType>()
  const schema = buildSchema(hidden)
  const description = buildDescription(hidden)

  return tool({
    description,
    inputSchema: schema,

    execute: async (input) => {
      if (onBeforeExecute) await onBeforeExecute()
      try {
        switch (input.command) {
          // ── Session ────────────────────────────────────────────────────────
          case 'session_append': {
            const role = input.role ?? 'user'
            const content = input.content ?? ''
            if (!content) return { output: 'Content is required.' }
            await store.sessionAppend(userId, sessionId, role, content, {
              toolName: input.tool_name ?? undefined,
            })
            return { output: `Session turn saved (role: ${role}).` }
          }

          case 'session_recent': {
            const entries = await store.sessionRecent(sessionId, input.limit ?? undefined)
            if (entries.length === 0) return { output: 'No session history.' }
            const formatted = entries.map((e) => `[${e.role}] ${e.content}`).join('\n')
            return { output: formatted }
          }

          // ── Semantic ───────────────────────────────────────────────────────
          case 'semantic_save': {
            const name = input.name ?? ''
            const description = input.content ?? ''
            if (!name || !description) return { output: 'name and content are required.' }
            await store.semanticSave(userId, name, description, {
              importance: input.importance ?? undefined,
              tags: input.tags ?? undefined,
            })
            return { output: `Semantic memory saved: "${name}".` }
          }

          case 'semantic_search': {
            const query = input.query ?? ''
            if (!query) return { output: 'query is required.' }
            const results = await store.semanticSearch(userId, query, input.limit ?? undefined)
            if (results.length === 0) return { output: 'No relevant semantic memories found.' }
            const formatted = results
              .map(
                (r, i) =>
                  `[${i + 1}] ${r.name}: ${r.description}${r.tags?.length ? ` (tags: ${r.tags.join(', ')})` : ''}`
              )
              .join('\n')
            return { output: formatted }
          }

          // ── Procedural ─────────────────────────────────────────────────────
          case 'procedural_save': {
            const task = input.task ?? ''
            const description = input.content ?? ''
            if (!task || !description) return { output: 'task and content are required.' }
            await store.proceduralSave(userId, task, description, {
              importance: input.importance ?? undefined,
              source: input.source ?? undefined,
            })
            return { output: `Procedural memory saved: "${task}".` }
          }

          case 'procedural_search': {
            const query = input.query ?? ''
            if (!query) return { output: 'query is required.' }
            const results = await store.proceduralSearch(userId, query, input.limit ?? undefined)
            if (results.length === 0) return { output: 'No relevant procedures found.' }
            const formatted = results.map((r, i) => `[${i + 1}] ${r.task}: ${r.description}`).join('\n')
            return { output: formatted }
          }

          // ── Episodic ───────────────────────────────────────────────────────
          case 'episodic_save': {
            const eventType = input.event_type ?? 'interaction'
            const description = input.content ?? ''
            if (!description) return { output: 'content is required.' }
            const id = await store.episodicSave(userId, eventType, description, {
              importance: input.importance ?? undefined,
              context: input.context ?? undefined,
            })
            return { output: `Episodic memory saved (id: ${id}).` }
          }

          case 'episodic_search': {
            const query = input.query ?? ''
            if (!query) return { output: 'query is required.' }
            const results = await store.episodicSearch(userId, query, input.limit ?? undefined)
            if (results.length === 0) return { output: 'No relevant episodes found.' }
            const formatted = results
              .map((r, i) => `[${i + 1}] [${r.event_type}] ${r.description}`)
              .join('\n')
            return { output: formatted }
          }

          // ── Scratchpad ─────────────────────────────────────────────────────
          case 'scratchpad_write': {
            const note = input.content ?? ''
            if (!note) return { output: 'content is required.' }
            const id = await store.scratchpadWrite(userId, sessionId, note)
            return { output: `Scratchpad note written (id: ${id}).` }
          }

          case 'scratchpad_read': {
            const notes = await store.scratchpadRead(sessionId)
            if (notes.length === 0) return { output: 'No active scratchpad notes.' }
            const formatted = notes.map((n, i) => `[${i + 1}] ${n.note}`).join('\n')
            return { output: formatted }
          }

          case 'scratchpad_promote': {
            const scratchpadId = input.scratchpad_id ?? ''
            const eventType = input.event_type ?? 'interaction'
            if (!scratchpadId) return { output: 'scratchpad_id is required.' }
            const { episodicId } = await store.scratchpadPromote(scratchpadId, userId, eventType, {
              importance: input.importance ?? undefined,
              context: input.context ?? undefined,
            })
            return { output: `Scratchpad note promoted to Episodic memory (id: ${episodicId}).` }
          }

          // ── Forget ─────────────────────────────────────────────────────────
          case 'memory_forget': {
            const memoryType = input.memory_type as MemoryType | null | undefined
            const id = input.id ?? ''
            if (!memoryType || !id) {
              return { output: 'memory_type and id are required.' }
            }
            const found = await store.forget(memoryType, id)
            return {
              output: found
                ? `Memory marked for deletion (type: ${memoryType}, id: ${id}).`
                : `No memory found to forget (type: ${memoryType}, id: ${id}).`,
            }
          }

          default:
            return { output: `Unknown or disabled command: ${input.command}.` }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e)
        return { output: `Memory action failed: ${msg}` }
      }
    },
  })
}
