# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
