# Eve + MongoDB memory + GROVE (OpenAI-compatible) — runnable example

A minimal [Vercel Eve](https://eve.dev) agent that:

- talks to your **GROVE** OpenAI-compatible gateway (via `@ai-sdk/openai-compatible`),
- has **durable MongoDB memory** across sessions (`@mongodb-developer/vercel-ai-memory/eve`),
- uses **GROVE for automatic memory capture** and **Atlas Automated Embedding** for vectors.

GROVE uses the Azure-style `api-key` header (not `Authorization: Bearer`), which
is handled in `agent/lib/grove.ts`.

## 1. Prerequisites

- Node.js **24+**
- A GROVE API key
- A MongoDB **Atlas** connection string (with Voyage AI enabled if you use `autoEmbed`)

## 2. Install & configure

> **Note:** the `/eve` adapter ships in **v0.5.0**, which is not on npm yet. This
> example depends on the package via a relative path (`"file:../.."`), so build
> the local package first.

```bash
# From the repo root — build the local package (creates dist/eve/*):
npm install
npm run build

# Then set up the example:
cd examples/eve-grove
npm install

cp .env.example .env.local     # then fill in GROVE_API_KEY and MONGODB_URI
export $(grep -v '^#' .env.local | xargs)   # or use your preferred dotenv loader
```

> **`.env.local` is for local development only** — it's gitignored; never commit
> real values (`.env.example` holds placeholders only). Use a development-only
> Atlas user here. When you deploy, store `MONGODB_URI` and `GROVE_API_KEY` as
> **Vercel Secrets** in the project's environment variables (or install the
> MongoDB Atlas Vercel integration, which sets `MONGODB_URI` for you), and
> `eve link` / `vercel env pull .env.local` to fetch them locally. See
> [Connection string & secrets](../../README.md#connection-string--secrets).

> Once v0.5.0 is published, you can instead depend on
> `"@mongodb-developer/vercel-ai-memory": "^0.5.0"` from npm.


> Quick sanity check that your key/endpoint work (matches the agent's config):
> ```bash
> curl -X POST "https://grove-gateway-prod.azure-api.net/grove-foundry-prod/openai/v1/chat/completions" \
>   -H "Content-Type: application/json" -H "api-key: $GROVE_API_KEY" \
>   -d '{ "model": "gpt-6-astra", "messages": [{ "role": "user", "content": "Hello!" }] }'
> ```

## 3. Run with a chat interface

### Option A — terminal chat (fastest)

```bash
npm run dev        # = eve dev  → interactive REPL / terminal UI
```

Type messages directly. Try the workshop flow:

1. `I'm responsible for technical partnerships. When preparing meetings, prioritize architecture risks, joint opportunities, and unresolved action items.`
2. Start a **new session** (in the dev TUI, `/new`).
3. `Prepare my next meeting.` → MongoDB recalls your durable preferences.

### Option B — web chat UI

Add the Next.js Web Chat channel when scaffolding a fresh project:

```bash
npx eve@latest init my-agent --channel-web-nextjs
```

Then copy this example's `agent/` folder into the scaffolded project (and the
two deps `@ai-sdk/openai-compatible`, `@mongodb-developer/vercel-ai-memory`), set
your env vars, and run `npm run dev`. The web chat is served locally by Eve; see
[Eve → Frontend Frameworks](https://eve.dev/docs/guides/frontend/overview).

## How it maps to your curl

| Your curl | This example |
| --- | --- |
| `baseURL …/openai/v1` | `createOpenAICompatible({ baseURL })` in `agent/lib/grove.ts` |
| `-H "api-key: $GROVE_API_KEY"` | `headers: { 'api-key': process.env.GROVE_API_KEY }` |
| `"model": "gpt-6-astra"` | `grove.chatModel(process.env.GROVE_MODEL ?? 'gpt-6-astra')` |

The same `groveModel` instance powers both the **agent** (`agent/agent.ts`) and
the **memory capture classifier** (`agent/memory/profile.ts`).

## Notes

- GROVE's endpoint is **chat/completions** only, so it's used as the agent model
  and the memory `captureModel` — embeddings come from Atlas Automated Embedding
  (`autoEmbed`). To use a client embedder instead, see Option B in
  `agent/memory/profile.ts`.
- Memory is partitioned by Eve's trusted `byPrincipal` scope; the model never
  chooses the memory owner.

## Stable identity in local dev (important)

Eve partitions every memory read/write by `memory.scope.key`, which is a
digest of **namespace + scope**. **Both** must be stable across runs, or each
`eve dev` / `eve invoke` writes to a new, empty partition and the agent
"forgets" you (you'll see a different `user_id` in MongoDB each time).

- **`scope`** — in production you'd use `byPrincipal` (the authenticated user).
  In eve's **local dev TUI / `eve invoke` there is no real auth**, so the
  anonymous principal changes between runs. We pin a stable dev id.
- **`namespace`** — when omitted, eve's *default* namespace includes a sha256 of
  the **build root** (`.eve/builds/<id>/…`), which changes on every start. So
  even with a pinned scope the key still changes each run. We set an explicit,
  stable namespace.

> Note: a custom **channel** auth walk does **not** fix this for the TUI — the
> local REPL bypasses route auth. The reliable fix is at the memory slot itself.

`agent/memory/profile.ts` does both:

```ts
const scope = (ctx) =>
  process.env.EVE_MEMORY_PROD ? byPrincipal(ctx) : [process.env.DEV_PRINCIPAL_ID ?? 'workshop-user']

export default defineMemory({
  namespace: process.env.MEMORY_NAMESPACE ?? 'eve-grove-memory-agent/profile',
  scope,
  provider: mongodbMemory({ /* … */ }),
})
```

- Change `DEV_PRINCIPAL_ID` to simulate a **different user** (separate memory).
- Change `MEMORY_NAMESPACE` to start a **fresh memory space** for the same user.
- Set `EVE_MEMORY_PROD=1` to get genuine per-authenticated-user scope.

Verify the partition is stable with `eve traces --verbose`: `gen_ai.memory.store.id`
must be identical across invocations, and `gen_ai.memory.record.count` should be
`> 0` in a brand-new session after you've saved something.

Demo flow that works across restarts (`eve invoke` runs each prompt in a new session):

```bash
eve invoke "My name is Pavel and I'm responsible for technical partnerships."
eve invoke "What is my name and what do I do?"   # → recalled from MongoDB
```

## Troubleshooting

**`Cannot compile agent compaction because the primary compaction trigger model "grove/gpt-6-astra" does not have known AI Gateway context window metadata`**

This does **not** mean Eve is routing through the AI Gateway. GROVE stays a
regular direct-provider dependency (`@ai-sdk/openai-compatible`) and inference
goes straight to GROVE. The message is only about a *lookup table*: Eve's
compaction needs the model's **context-window size**, and it only knows those
sizes from a built-in table keyed by AI Gateway model IDs. A direct-provider
model isn't in that table, so you supply the number yourself.

Fix (confirmed against `eve@0.55` types): set `modelContextWindowTokens` at the
**agent level** in `agent/agent.ts`. Eve uses it verbatim and skips the Gateway
lookup:

```ts
export default defineAgent({
  model: groveModel,
  modelContextWindowTokens: 128_000, // set to gpt-6-astra's real context window
})
```

(You can override the value via `GROVE_CONTEXT_WINDOW` in your env.) If you ever
configure a separate compaction summary model, `compaction.modelContextWindowTokens`
is the equivalent escape hatch for that model.

**`No matching version found for @mongodb-developer/vercel-ai-memory@^0.5.0`**

The `/eve` adapter ships in v0.5.0, which isn't on npm yet — this example
depends on the local package via `"file:../.."`. Build the local package first
(`npm install && npm run build` from the repo root).


