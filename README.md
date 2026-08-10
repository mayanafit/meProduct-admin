# meProduct-admin

A small storefront plus admin dashboard: Express 5, EJS, Tailwind, SQLite
(better-sqlite3), TypeScript, tested with Vitest.

- **`/`** — customer storefront: browse, cart, checkout, order lookup
- **`/admin`** — product and order management, stock history
- **Chat assistant** on the storefront, powered by a model you run locally

## Getting started

```sh
nvm use                 # Node 24.18 (see .nvmrc)
pnpm install
cp .env.example .env
pnpm seed               # 15 products into data.sqlite
pnpm css:build          # or css:watch alongside dev
pnpm dev                # http://localhost:3000
```

| Script | What it does |
| --- | --- |
| `pnpm dev` | Run the app with reload |
| `pnpm test` / `test:run` | Vitest (watch / once) |
| `pnpm test:coverage` | Coverage report, HTML in `coverage/` |
| `pnpm typecheck` | Typecheck including tests |
| `pnpm eval:model` | Score your local model on the assistant's task |
| `pnpm seed` | Seed the database |
| `pnpm css:build` / `css:watch` | Build Tailwind |

## The shop assistant

The assistant runs against **your own local model** — no API key, no cost,
nothing leaves the machine. It talks to any OpenAI-compatible
`/v1/chat/completions` endpoint, so Ollama, LM Studio, llama.cpp's
`llama-server`, Jan and vLLM all work by changing `LLM_BASE_URL` alone.

```sh
ollama serve
ollama pull llama3.2:3b
pnpm eval:model
```

Without a model running, the app works normally and the widget explains how to
start one.

The model does **one** job: turn a sentence into a small JSON object
(`{intent, query, quantity, …}`). Everything after that — searching, resolving
which product is meant, changing the cart — is ordinary tested code. Two
consequences worth knowing:

- **The assistant cannot place an order.** It can fill a cart; checkout stays a
  human action on `/checkout`.
- **Product descriptions are never sent to the model.** It only sees the
  shopper's own words, so a description can't smuggle in instructions.

### Choosing a model

Size matters more than you'd expect. Measured on an Apple M1 with 8 GB RAM:

| Model | Size | Cold start | Warm turn | Intent accuracy |
| --- | --- | --- | --- | --- |
| `llama3.2:3b` | 2.0 GB | ~6 s | ~0.5 s | **93%** (14/15) |
| `llama3:latest` (8B) | 4.7 GB | ~4 min | — | not usable here |

The 8B model doesn't fit alongside a desktop in 8 GB, so it swaps and every turn
takes minutes. A 3B model answers in well under a second. Run `pnpm eval:model`
against whatever you have — it reports accuracy and per-turn latency, and a
score below 70% means the assistant will misread a lot of messages.

## Notes and limitations

- **No authentication.** `/admin` is open to anyone who can reach the host.
  Fine on localhost; do not deploy as-is.
- Search is a SQL `LIKE`, so it matches words rather than meaning — "bags" will
  not find "Backpack".
- Assistant replies are templated: it understands free-form questions but
  answers in fixed phrasing.
- Sessions are in-memory, so carts and conversations reset when the app
  restarts.
