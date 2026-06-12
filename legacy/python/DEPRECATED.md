# Deprecated — Python pipeline

**Status:** retired on 2026-06-12. This tree is preserved as a historical
reference for porting decisions and as the source of truth for parity test
fixtures under `app/tests/parity/`. It is **not executed in production** and
is **not the source of truth** for any business logic.

## What's authoritative now

| Surface | Authoritative implementation |
|---|---|
| Recommendation pipeline (models, refiner, guardrails) | `app/src/` (TypeScript) |
| Pipeline orchestration | `app/src/pipeline/runModels.ts` |
| Skill catalog | `app/src/agent/skills/` |
| Executor (Google Ads mutates) | `app/src/http/routes/execute.ts` |
| Schema / migrations | `app/src/db/schema.ts` |
| Cron / chat / outcomes | `app/src/http/routes/{cron,chatWebhook}.ts` |
| Deploy target | Godeploy app `gotrends-agent` (`af427329`) |

## What this directory still contains

- `models/` — original NumPy/pandas implementations. Behaviour is preserved
  in the TS port; divergences (intentional or not) are documented in the
  matching TS file's top docstring.
- `queries/` — the original SQL used during local Apice runs. The worker
  embeds canonical versions inline (`app/src/pipeline/runModels.ts`).
- `agent/` — recommendation_agent.py is the reference that
  `app/src/agent/recommendationAgent.ts` was ported from.
- `tools/` — one-off scripts. Parity fixture generator at
  `tools/generate_parity_fixtures.py` (repo root) still uses these to
  regenerate `app/tests/parity/*.csv` when the underlying SQL changes.

## When to look at this code

- **Investigating parity test failures** — compare the TS implementation to
  the Python source side-by-side.
- **Auditing the migration** — confirming that a given TS file faithfully
  reproduces the Python logic.
- **Regenerating parity fixtures** — `python tools/generate_parity_fixtures.py`
  reads `legacy/python/models/*.py` and writes fresh CSVs.

## When NOT to touch this code

- Bug fixes (fix in `app/src/`).
- Behaviour changes (change in `app/src/`).
- New skills or guardrails (add in `app/src/`).
- Anything customer-facing — this tree does not run.

If you find yourself editing here for any reason other than fixture
regeneration, stop and move the change to `app/src/`.
