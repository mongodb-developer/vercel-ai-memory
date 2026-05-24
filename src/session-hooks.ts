import type {
  ModelMessage,
  AssistantModelMessage,
  ToolModelMessage,
} from '@ai-sdk/provider-utils'
import type { MongoMemoryStore } from './store'
import type { SessionMemory } from './types'

// ─── Public option shapes ─────────────────────────────────────────────────────

/**
 * Scope for the deterministic session hooks.
 */
export interface SessionHookOptions {
  /** The user this session belongs to. */
  userId: string
  /** The session id to read/write. */
  sessionId: string
  /**
   * Max number of prior turns to load with `loadSession`.
   * Defaults to the store's `defaults.sessionRecentLimit` (40).
   */
  limit?: number
  /**
   * If set, the user prompt passed to the `generate()` call is persisted as a
   * `user` session turn. Default: true.
   * Disable if you already store the user turn yourself (e.g. in an API
   * handler before calling the agent).
   */
  persistUserPrompt?: boolean
}

// Re-export the ToolLoopAgent onFinish callback shape without importing `ai`
// as a hard dependency — we keep `ai` peer-only. The shape below matches
// `OnFinishEvent` (StepResult + steps[] + experimental_context).
// We accept a widened shape because we don't want to import TOOLS generics.
type AnyOnFinishEvent = {
  steps: ReadonlyArray<AnyStepResult>
  experimental_context?: unknown
  response?: { messages?: ReadonlyArray<ResponseMessageLike> }
} & Record<string, unknown>

type AnyStepResult = {
  stepNumber: number
  response: {
    messages: ReadonlyArray<ResponseMessageLike>
  }
}

type ResponseMessageLike = AssistantModelMessage | ToolModelMessage

/**
 * The callable returned by `createOnFinish`. Compatible with
 * `ToolLoopAgentOnFinishCallback`, `GenerateTextOnFinishCallback`, and
 * `StreamTextOnFinishCallback` in the Vercel AI SDK.
 */
export type OnFinishCallback = (event: AnyOnFinishEvent) => Promise<void>

// ─── Loader: deterministic history read ───────────────────────────────────────

/**
 * Load prior session turns from Mongo and return them as `ModelMessage[]`,
 * ready to be prepended to the next LLM call (via `prepareCall` or by
 * merging into `messages` before `generateText`).
 *
 * Runs deterministically — does not depend on the LLM deciding to call a
 * `session_recent` tool.
 */
export async function loadSession(
  store: MongoMemoryStore,
  opts: SessionHookOptions
): Promise<ModelMessage[]> {
  const turns: SessionMemory[] = await store.sessionRecent(opts.sessionId, opts.limit)
  return turns.flatMap((turn) => {
    const message = sessionTurnToModelMessage(turn)
    return message ? [message] : []
  })
}

function sessionTurnToModelMessage(turn: SessionMemory): ModelMessage | null {
  switch (turn.role) {
    case 'user':
      return { role: 'user', content: turn.content }
    case 'assistant':
      return { role: 'assistant', content: turn.content }
    case 'tool':
      // Do not replay standalone tool results into provider input. OpenAI
      // Responses and Anthropic Messages both require each tool-result block to
      // match a tool-use/tool-call in the immediately preceding assistant turn.
      // Session memory stores a readable transcript/audit trail, not an exact
      // provider replay log, so restored history intentionally excludes tool
      // messages to avoid orphan tool-result validation errors.
      return null
  }
}

// ─── Writer: deterministic persistence on generation end ──────────────────────

/**
 * Shape that `createOnFinish` looks for in `event.experimental_context` when
 * called without a baked-in scope. Pass this via
 * `agent.generate({ experimental_context })` to let a constructor-level
 * `onFinish` be scoped per-call without re-creating the agent.
 */
export interface OnFinishContext {
  userId: string
  sessionId: string
  /** Optional user prompt to persist as the leading `user` turn. */
  prompt?: string | ModelMessage[]
}

/**
 * Build an `onFinish` callback that persists **every** user, assistant, and
 * tool turn from a generation to session memory — exactly once per generate()
 * call. Compatible with `ToolLoopAgent.onFinish`, `generateText`'s `onFinish`,
 * and `streamText`'s `onFinish`.
 *
 * This eliminates the non-determinism of letting the LLM decide whether to
 * call `session_append` as a tool.
 *
 * ## Two calling modes
 *
 * **1. Closure mode** — bake scope in at callback-creation time:
 * ```ts
 * onFinish: memory.onFinish({ userId, sessionId, prompt })
 * ```
 *
 * **2. Context mode** — read scope from `event.experimental_context`.
 *    Required for `ToolLoopAgent`, which only accepts a single constructor
 *    level `onFinish` but forwards `experimental_context` per call:
 * ```ts
 * // construction
 * new ToolLoopAgent({ onFinish: memory.onFinish(), ... })
 * // per call
 * agent.generate({ prompt, experimental_context: { userId, sessionId, prompt } })
 * ```
 *
 * If `opts` is omitted, the hook *requires* an `experimental_context` with at
 * least `{ userId, sessionId }`. If `opts` is provided, any missing fields are
 * still back-filled from the context (context wins per-call if both present).
 *
 * @param store  The MongoMemoryStore.
 * @param opts   Optional static scope (userId, sessionId, prompt) for the writes.
 */
export function createOnFinish(
  store: MongoMemoryStore,
  opts?: Partial<SessionHookOptions> & { prompt?: string | ModelMessage[] }
): OnFinishCallback {
  const persistUserPrompt = opts?.persistUserPrompt ?? true

  return async (event) => {
    const ctx = (event.experimental_context ?? {}) as Partial<OnFinishContext>

    const userId = ctx.userId ?? opts?.userId
    const sessionId = ctx.sessionId ?? opts?.sessionId
    const prompt = ctx.prompt ?? opts?.prompt

    if (!userId || !sessionId) {
      // eslint-disable-next-line no-console
      console.warn(
        '[mongodb-memory] session onFinish: no userId/sessionId found ' +
          '(pass them via opts or via `experimental_context` on generate()).'
      )
      return
    }

    try {
      const turns: Array<{
        role: SessionMemory['role']
        content: string
        toolName?: string
      }> = []

      // 1. Persist the incoming user prompt (if provided and enabled).
      if (persistUserPrompt && prompt !== undefined) {
        collectPromptTurns(turns, prompt)
      }

      // 2. Persist every response message across all steps.
      //    `event.steps` is the authoritative list: one StepResult per LLM
      //    call in the tool loop. Each step's response.messages contains the
      //    new assistant (+ possibly tool) messages produced in that step.
      const steps = event.steps ?? []
      for (const step of steps) {
        const messages = step.response?.messages ?? []
        for (const msg of messages) {
          collectResponseMessageTurn(turns, msg)
        }
      }

      if (turns.length > 0) {
        await store.sessionAppendMany(userId, sessionId, turns)
      }
    } catch (err) {
      // Best-effort: we never want to break the generation because memory
      // persistence failed. Surface via console so it's observable.
      // eslint-disable-next-line no-console
      console.warn(
        `[mongodb-memory] session onFinish persistence failed: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }
  }
}

function collectPromptTurns(
  turns: Array<{
    role: SessionMemory['role']
    content: string
    toolName?: string
  }>,
  prompt: string | ModelMessage[]
): void {
  if (typeof prompt === 'string') {
    if (prompt.length === 0) return
    turns.push({ role: 'user', content: prompt })
    return
  }

  // Array of ModelMessage — persist any new user/assistant/tool messages.
  // Typical case: a single user turn, but we handle all for completeness.
  for (const msg of prompt) {
    if (msg.role === 'system') continue
    const text = extractText(msg)
    if (!text) continue
    if (msg.role === 'user') {
      turns.push({ role: 'user', content: text })
    } else if (msg.role === 'assistant') {
      turns.push({ role: 'assistant', content: text })
    } else if (msg.role === 'tool') {
      turns.push({ role: 'tool', content: text, toolName: firstToolName(msg) })
    }
  }
}

function collectResponseMessageTurn(
  turns: Array<{
    role: SessionMemory['role']
    content: string
    toolName?: string
  }>,
  msg: ResponseMessageLike
): void {
  if (msg.role === 'assistant') {
    const text = extractText(msg)
    if (!text) return
    turns.push({ role: 'assistant', content: text })
    return
  }

  if (msg.role === 'tool') {
    const text = extractText(msg)
    if (!text) return
    turns.push({ role: 'tool', content: text, toolName: firstToolName(msg) })
  }
}

// ─── Helpers to extract plain text from ModelMessage shapes ───────────────────

function extractText(msg: ModelMessage): string {
  const content = (msg as { content: unknown }).content

  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''

  const parts: string[] = []
  for (const part of content as Array<Record<string, unknown>>) {
    if (!part || typeof part !== 'object') continue

    // Text part
    if (part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text)
      continue
    }

    // Tool result part (in tool messages). The SDK v5 shape is
    // { type: 'tool-result', output: { type: 'text', value: '...' } | ... }
    if (part.type === 'tool-result') {
      const output = part.output as
        | { type?: string; value?: unknown }
        | string
        | undefined
      if (typeof output === 'string') {
        parts.push(output)
      } else if (output && typeof output === 'object') {
        if (output.type === 'text' && typeof output.value === 'string') {
          parts.push(output.value)
        } else if (output.value !== undefined) {
          parts.push(safeStringify(output.value))
        }
      }
      continue
    }

    // Tool call part (in assistant messages that decided to call a tool)
    if (part.type === 'tool-call') {
      const name = part.toolName ?? 'unknown'
      parts.push(`[tool-call: ${name}]`)
      continue
    }
  }
  return parts.join('\n').trim()
}

function firstToolName(msg: ModelMessage): string | undefined {
  const content = (msg as { content: unknown }).content
  if (!Array.isArray(content)) return undefined
  for (const part of content as Array<Record<string, unknown>>) {
    if (part && typeof part === 'object') {
      if (part.type === 'tool-result' && typeof part.toolName === 'string') {
        return part.toolName
      }
      if (part.type === 'tool-call' && typeof part.toolName === 'string') {
        return part.toolName
      }
    }
  }
  return undefined
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}
