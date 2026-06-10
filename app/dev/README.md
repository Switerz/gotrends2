# Dev server

Local development host for the GoTrends v2 app. Runs the same Hono Worker that
ships to Godeploy, but against a node-backed SQLite database that conforms to
the Godeploy `env.DB` interface.

## Run

```bash
npm install
npm run dev
```

This starts two processes in parallel:

- **Backend** (Hono Worker + local SQLite) on http://localhost:8787
- **Frontend** (Vite dev server) on http://localhost:5173

Open http://localhost:5173 in the browser. The Vite dev server proxies `/api/*`
and `/chat/*` to the backend.

## What gets seeded

On first start a local SQLite file `dev.db` is created and pre-populated with:

- 3 model runs (recent + a couple older)
- ~30 recommendations spanning every workflow status (`pending`,
  `sent_to_chat`, `approved`, `rejected`, `executed`, `failed`, `expired`) and
  the guardrail edge cases (`ok` / `needs_human_review` / `blocked`)
- A handful of execution rows (both success and failure)
- A few execution outcomes so the post-mutate views are populated

Subsequent restarts re-use the existing `dev.db` (idempotent — won't re-seed).

## Reset the local DB

```bash
rm app/dev.db*
npm run dev
```

## Environment variables

For the dev server, only `PORT` and `DEV_DB_PATH` are read by default.
Optional outbound integrations (Google Ads, Metabase, Google Chat) can be set
in a `.env.local` if you want to test live mutate / chat flows.

## Troubleshooting

- `[dev] Failed to start: ...` — verify port 8787 is free
- Empty pages in the UI — check the backend logs and verify
  `http://localhost:8787/api/health` returns `{"ok":true}`
- Type errors after pulling — `npm install` to refresh native bindings for
  `better-sqlite3`

## Deploy to Godeploy

Stage the build (Vite + worker source rewrite):

```bash
npm run stage:deploy
```

This produces `.deploy/gotrends-agent/` at the repo root with:
- `index.html`, `favicon.svg`, `assets/index-*.{js,css}` (Vite output)
- `src/` (worker source with `@/` paths rewritten to relative)
- `package.json` (only runtime deps)

Then upload via Godeploy MCP tools and call `createApp` (first time) or `updateApp` (subsequent) with:
- `entrypoint: 'src/index.ts'`
- `assets: ['index.html', 'favicon.svg', 'assets/index-<HASH>.js', 'assets/index-<HASH>.css']` (use exact hashed names from the build log)
- `assetConfig: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application' }`

Current production app: https://gotrends-agent.devgogroup.com/ (app id `af427329`).
