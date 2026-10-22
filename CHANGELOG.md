# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] — 2026-10-06

Security hardening from the product-security threat model (P0-1: finding #3
"memory is not isolated between users and sessions", and #9 prompt injection).

### Security
- **Owner-scoped `forget`.** `memory_forget` (AI SDK tool) and the Eve `forget`
  tool still run **automatically** (no approval step), but now only within the
  caller's trusted scope: the update filter is `{ _id, user_id }`. Previously
  the filter was `{ _id }` only, so a prompt-injected agent that learned another
  user's document id could delete it. Ids owned by another scope — and
  malformed ids — now report "not found" and modify nothing.
- **Owner-scoped `scratchpadPromote`.** Only a note owned by the caller (and
  not already promoted) can be promoted. Previously any note id could be copied
  into the caller's episodic memory, leaking its content across users.
- **Session and scratchpad reads filter by `user_id` + `session_id`.**
  `sessionRecent`, `scratchpadRead`, and `loadSession` previously filtered by
  `session_id` only, so a guessed or client-supplied session id exposed another
  user's conversation.
- **Fail-closed scope.** Every public store method rejects a missing or empty
  `userId` / `sessionId`. `mongodbMemory()` no longer falls back to a shared
  `'default'` bucket — it throws when no scope can be resolved. An explicitly
  empty / whitespace / non-string per-call scope also throws; only an omitted
  (`undefined`) scope falls back to a creation-time default.
- Tool description now tells the model that retrieved memory is user-provided
  data (not instructions) and to never store secrets (Eve / AI SDK guidance).

### Added
- `allowSharedDefaultScope` option (default `false`) — demo-only opt-in to the
  legacy shared `'default'` userId / sessionId.
- Owner-first indexes `session_user_seq` (`{ user_id, session_id, seq: -1 }`)
  and `scratchpad_user_session` (`{ user_id, session_id, created_at: -1 }`)
  backing the scoped reads. Created by `bootstrap()`; existing indexes are kept.

### Changed — BREAKING
Store method signatures now take the owner scope first:

| Before (0.5) | After (0.6) |
|---|---|
| `store.forget(type, id)` | `store.forget(userId, type, id)` |
| `store.sessionRecent(sessionId, limit?)` | `store.sessionRecent(userId, sessionId, limit?)` |
| `store.scratchpadRead(sessionId)` | `store.scratchpadRead(userId, sessionId)` |

`mongodbMemory()` with no `userId` / `sessionId` (and no creation-time
defaults) now throws. Pass scope per call from your verified server-side auth
session, or set `allowSharedDefaultScope: true` for single-user demos.

The tool schema and the Eve provider API are unchanged — only direct
`store.*` callers need to update.

### Fixed
- **Session hooks work on AI SDK v7.** AI SDK v7 renamed
  `experimental_context` to `runtimeContext` (and `onFinish` to `onEnd`). The
  context-mode `onFinish()` hook only read `experimental_context`, so on v7 it
  silently saved **no transcript**; it only logged a warning. It now reads
  `finalStep.runtimeContext`, `runtimeContext`, and `experimental_context`,
  so it works on v6 and v7. On v7, return `runtimeContext` from `prepareCall`
  and pass the hook as `onEnd` (see README). Closure mode was unaffected.
- **Atomic `scratchpadPromote`.** The note is claimed with a single
  owner-scoped `findOneAndUpdate` before the episodic write, so concurrent
  promotions of the same note produce exactly one episodic memory. If the
  episodic write fails, the claim is released.
- **`episodicExists` owner scope cannot be overridden.** The trusted
  `user_id` is now applied after the caller's filter, so a `user_id` key in
  the filter can no longer replace the scope.
- Root package type exports now point to the generated ESM (`index.d.mts`)
  and CommonJS (`index.d.ts`) declarations instead of a missing `index.d.cts`.
- Release tests validate built package exports and Eve dependency isolation.

### CI
- New `CI` GitHub Actions workflow runs lint, build, unit, and integration
  tests against a local Atlas service (`mongodb/mongodb-atlas-local`) on every
  pull request and push to `main`.
- `ci/ai-ml-pipeline-testing/` contains the `vercel-ai-memory-js` test
  definition for MongoDB's `ai-ml-pipeline-testing` Evergreen project.

### Documentation
- New README section **"Connection string & secrets"**: production guidance
  for storing `MONGODB_URI` as a **Vercel Secret** (write-only) — via the
  MongoDB Atlas Vercel integration or `vercel env add` — with per-environment
  credentials, server-only access (no `NEXT_PUBLIC_`), least-privilege Atlas
  users, network access lists, a zero-downtime rotation procedure, and an
  optional lazy `getMemory()` pattern so the URI isn't read at build time.
  Addresses threat-model finding #5 (connection secret in plain environment
  variables). The same guidance was added to the Eve section and the
  `examples/eve-grove` README. No code changes — the package already receives
  the URI as a value and never reads `process.env` itself.

## [0.5.0] — 2026-09-15

### Added
- **First-class Vercel Eve memory provider** — a new, additive subpath export
  `@mongodb-developer/vercel-ai-memory/eve` exposing `mongodbMemory()` (aliased
  as `mongodb()`). It implements the Eve memory provider contract
  (`recall["turn.started"]`, optional `capture["turn.completed"]`, and provider
  `tools`) as a thin adapter over the existing `MongoMemoryStore`.
  - **Automatic relevant recall** before each turn across the semantic,
    episodic, and procedural tiers.
  - **Capture modes**: `"automatic"` (default, matching the Supermemory /
    Upstash AgentKit convention — extracts & classifies durable memories via an
    optional `captureModel`, with a heuristic fallback when none is supplied),
    `"agent"` (model-driven `remember` / `forget` tools), and `false`
    (recall only).
  - **Trusted scope isolation**: every read and write is partitioned by the
    Eve-supplied `ctx.memory.scope.key` (used as the store `userId`). The model
    can never provide or choose the memory owner.
  - Eve owns the session/runtime lifecycle, so the adapter disables the
    session + scratchpad tiers. This applies **only** to the Eve adapter.
  - `eve` is declared as an **optional peer dependency** — existing AI SDK users
    who never import `/eve` are not required to install it, and the root bundle
    contains no `eve` imports.
- **Opt-in Atlas Automated Embedding** for the core store — pass
  `autoEmbed: { model }` (instead of `embedder`) to let MongoDB Atlas generate
  and manage vector embeddings server-side (Voyage AI). Available to both the
  AI SDK integration and the Eve adapter. Requires Atlas with Voyage AI enabled
  and (on dedicated `M10+` clusters) storage auto-scaling.

### Changed
- `MongoDBMemoryOptions.embedder` is now **optional** — required only when
  `autoEmbed` is not supplied. Exactly one of `embedder` / `autoEmbed` must be
  provided. **No behavior change** for existing users who pass `embedder`.
- **Eve adapter: capture is now idempotent on `ctx.operationId`.** The Eve
  provider contract states that eve may replay a handler with the same
  `operationId`. Semantic and procedural captures were already replay-safe
  (upsert on `(scope, label)`), but episodic captures used a plain insert and
  would duplicate the event on replay. Episodic memories written by
  `capture["turn.completed"]` are now tagged with `context.eve_operation_id`
  and a replayed operation is a no-op. Adds `MongoMemoryStore.episodicExists()`.
- **Eve adapter: `remember` tool accepts confidence-style importance.** Models
  frequently emit `importance` as a 0–1 fraction (observed with GROVE:
  `importance: 0.9`). The tool schema previously required `1–10` and rejected
  the call (`AI_InvalidToolInputError`), costing a wasted tool round-trip and
  losing the score. Values in `0 < x <= 1` are now scaled to `1–10`; out-of-range
  values are clamped; integers pass through unchanged.
- **Eve adapter: quieter logs.** The "memory type … is disabled" operator
  notice is no longer emitted for the Eve provider, where disabling the session
  and scratchpad tiers is by design (Eve owns the session lifecycle). The
  notice is unchanged for the root AI SDK integration. `resolveConfig()` gains
  an internal `{ quietDisabledNotices }` option.

### Fixed
- **`examples/eve-grove`: memory did not persist across runs.** Eve's memory
  partition key is a digest of *namespace + scope*. When `namespace` is omitted,
  Eve's default namespace includes a hash of the build root (`.eve/builds/<id>`),
  which changes on every `eve dev` / `eve invoke` — so even with a pinned scope
  the agent wrote to a fresh partition each run and never recalled anything.
  The example now sets an explicit, stable `namespace` alongside the stable dev
  `scope`. (Verified with `eve traces`: `gen_ai.memory.store.id` is now constant
  and `gen_ai.memory.record.count` > 0 in a brand-new session.)

### Compatibility
- Fully backward compatible. `createMongoDBMemory`, the AI SDK memory tool, all
  store APIs, memory types, session/scratchpad behavior, configuration defaults,
  and existing exports are unchanged. All existing tests pass unmodified.


## [0.4.2] — 2026-06-24

### Added
- **MongoDB driver handshake metadata** — `createMongoDBMemory` now sets
  `driverInfo.name` and `driverInfo.version` on the `MongoClient` it constructs
  so server-side telemetry can attribute connections back to the library.
  When the client supports `appendMetadata`, the `DRIVER_INFO` record is
  appended; the call is safely skipped on older driver versions.

## [0.4.1] — 2026-06-18

### Fixed
- **zod peer dependency widened to support v4** — `zod` peer range is now
  `^3.25.76 || ^4.1.8`, matching what the `ai` SDK already allows. This resolves
  `npm ERESOLVE` peer-dependency conflicts for consumers using `ai@7` with
  `zod@4`. The `z.record(z.unknown())` call in the memory tool schema was updated
  to the two-argument form `z.record(z.string(), z.unknown())`, which is valid in
  both zod 3 and zod 4.
- **mongodb peer dependency widened to support v7** — `mongodb` peer range is now
  `^6.0.0 || ^7.0.0`. Verified against `mongodb@7.3.0` (lint, build, and all unit
  tests pass); the package's `MongoClient`, `Db`, `Collection`, `ObjectId`,
  `Filter`, and `Document` usage is unchanged across the v6 → v7 boundary. This
  prevents an `invalid peer` error for consumers who let `npm install mongodb`
  resolve to the newly released v7.

## [0.4.0] — 2026-06-18

### Changed
- **AI SDK peer dependency widened to support v7** — `ai` peer range is now
  `^6.0.0 || ^7.0.0`. Verified against `ai@7.0.0-beta.181` (lint, unit tests,
  and build all pass); the package's `embed`, `tool`, `ModelMessage`,
  `AssistantModelMessage`, and `ToolModelMessage` usage is unchanged across the
  v6 → v7 major boundary.

## [0.3.0] — 2026-05-24

### Fixed
- **Safe session restore for tool loops** — `loadSession()` now restores only
  `user` and `assistant` turns as provider `ModelMessage[]`. Persisted `tool`
  turns remain in MongoDB as transcript/audit records, but are no longer
  replayed as standalone `tool-result` blocks that OpenAI Responses and
  Anthropic Messages reject without a matching prior tool call.

### Changed
- **Batched deterministic session writes** — `onFinish()` now collects the user
  prompt plus all assistant/tool messages and persists them via a single
  `sessionAppendMany()` batch, reducing MongoDB roundtrips for multi-step tool
  loops.
- **AI SDK peer dependency narrowed to v6** — `ai` peer range is now
  `^6.0.0`, matching the package's `ModelMessage`, `ToolLoopAgent`, and
  `isLoopFinished()` usage.
- README and examples now use `stopWhen: isLoopFinished()`.

### Added
- `MongoMemoryStore.sessionAppendMany()` for ordered batch insertion of session
  turns while preserving the existing `sessionAppend()` API.
- MongoDB uniqueness guardrails:
  - unique `{ session_id, seq }` index for session turn ordering;
  - partial unique latest-doc indexes for semantic/procedural history mode.

## [0.2.1] — 2026-04-28

### Changed
- **Semantic & procedural saves now upsert in place by default** — instead of
  always inserting a new document and marking old ones `is_latest: false`,
  `semanticSave` and `proceduralSave` now perform a single `updateOne` with
  `upsert: true`, keyed on `(user_id, name)` and `(user_id, task)` respectively.
  This reduces document count, index bloat, and write operations from two ops
  (updateMany + insertOne) to one.

### Added
- `topology.keepHistory` option (`boolean`, default `false`) — when set to
  `true`, restores the previous temporal-versioning behavior where each save
  inserts a new document and old versions are retained with `is_latest: false`.
  Use this if you need an audit trail of memory changes.

## [0.2.0] — 2026-04-27

### Added
- **Deterministic session memory via Vercel AI SDK hooks** — new public API:
  - `mongodbMemory.loadSession({ userId, sessionId })` — pre-hook that reads
    prior session turns from Mongo and returns them as `ModelMessage[]`, ready
    to prepend to `messages` in `prepareCall` (or before `generateText` /
    `streamText`).
  - `mongodbMemory.onFinish(opts?)` — post-hook callback compatible with
    `ToolLoopAgent.onFinish`, `generateText({ onFinish })`, and
    `streamText({ onFinish })`. Walks the full `steps[]` and persists the user
    prompt plus every assistant and tool message, exactly once per generation.
  - Two calling modes supported: **closure mode** (bake scope at creation) for
    one-shot calls, and **context mode** (read scope from
    `event.experimental_context`) for reusable `ToolLoopAgent` instances.
- `topology.hideToolCommands: MemoryType[]` — hide a memory type's commands
  from the LLM tool schema **without** disabling the underlying collection or
  store methods. Use alongside the new session hooks for deterministic,
  runtime-driven session memory.
- `examples/deterministic-agent.ts` — full runnable example demonstrating the
  hook-based pattern.

### Changed
- `MemoryConfig` now exposes a resolved `hiddenFromTool: Set<MemoryType>` set
  (always a superset of `disabled`) used by the tool schema builder to decide
  which commands to emit. `disabled` keeps its stricter semantics: no bootstrap,
  no tool commands, store methods throw.
- `README.md` now documents the two session modes (tool-driven vs hook-driven)
  with a production recommendation toward Mode B.

### Fixed
- None (no behavior changes for users not adopting the new hooks).

## [0.1.0] — 2026-04-23

### Added
- Initial release: MongoDB-backed memory provider for the Vercel AI SDK with
  Session, Semantic, Procedural, Episodic, and Scratchpad memory tiers, Atlas
  Vector Search integration, per-type retention policies (`none`, `ttl`,
  `ttl+importance`, `dynamic`), agent-driven `memory_forget`, and lazy
  bootstrap.
