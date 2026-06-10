# gotrends-agent

Active worker app for **GoTrends v2** — the campaign intelligence engine.

## Stack

- **TypeScript** (strict, ES2022, bundler resolution)
- **Hono** — HTTP router for the worker
- **React + Vite** — client UI
- **Vitest** — unit & parity tests
- **Cloudflare Workers** via **Godeploy**

## Scripts

```bash
npm test            # run vitest once
npm run test:watch  # vitest in watch mode
npm run test:parity # only the parity suite (vs. legacy Python)
npm run typecheck   # tsc --noEmit
npm run dev         # vite dev server (client)
npm run build:client # vite production build
```

## Layout & plan

- Repo structure rules: see `../docs/ARCHITECTURE.md` (canonical, do not edit casually).
- Live migration plan: `../docs/plans/2026-06-10-godeploy-platform-migration.md`.
- Legacy Python lives under `../legacy/python/` — reference only, frozen.
