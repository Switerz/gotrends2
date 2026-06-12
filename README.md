# GoTrends v2

Sistema analitico para apoiar decisoes de otimizacao de campanhas de Google Ads da Apice/GoGroup.

O principio do projeto e manter a decisao em uma camada deterministica/estatistica e usar LLM apenas para explicar recomendacoes, riscos e restricoes para aprovacao humana.

## Estrutura do repositorio

A migracao para Godeploy esta concluida. O worker TypeScript em `app/` e o
sistema vivo; o pipeline Python ficou arquivado em `legacy/python/` apenas
como referencia historica e como fonte das fixtures dos testes de paridade.

```text
app/            # Worker TypeScript — SISTEMA VIVO (deploy: Godeploy gotrends-agent)
  src/         #   pipeline, modelos, refiner, guardrails, executor, http, db
  client/      #   SPA React
  tests/       #   479+ testes incluindo paridade contra fixtures Python
legacy/python/  # ARQUIVADO em 2026-06-12 — ver legacy/python/DEPRECATED.md
tools/          # Scripts cross-stack (geracao de fixtures, etc.)
docs/           # Documentacao tecnica
```

A estrutura canonica esta descrita em `docs/ARCHITECTURE.md`.

## Status

Pipeline rodando em producao via Godeploy:

- Cron diario `run-models` (06:00 UTC) — geracao de recomendacoes
- Cron `send-to-chat` 15min — push de cards no Google Chat
- Cron `outcomes/24h` e `outcomes/72h` — coleta de realised vs expected
- Aprovacao via SPA (`/api/recommendations/:id/approve`) com fire-and-forget executor
- Guardrails: hard block >50%, soft caps cumulativos em tROAS (40%/dia + 30%/7d), needs_human_review por confianca/anomalia/risco

Output local separa:

```text
ga4_roas = raw.ga4_gogroup_all_channels.purchase_revenue / cost
ads_roas = Google Ads conversion value / cost
```

O `roas` principal e o ROAS de negocio (`ga4_roas`). Comparacoes com `target_roas` usam `ads_roas`.

## Fonte de dados

Banco Metabase: `Data Mart`. Tabelas principais:

```text
raw.gogroup_google_ads
raw.gogroup_google_ads_campaigns
raw.gogroup_google_ads_keywords
raw.ga4_gogroup_all_channels
```

Detalhes e descobertas em `DATA_DICTIONARY.md`.

## Documentacao essencial

Em ordem de relevancia para mexer no codigo hoje:

- `docs/ARCHITECTURE.md` — estrutura canonica do repo e contratos por camada
- `docs/GUARDRAILS.md` — stack completo de guardrails do worker TS (hard block, soft caps, learning phase, dedup)
- `docs/VERIFICATION.md` — post-execute verification (cron 6h, GAQL vs proposed)
- `docs/SESSION_2026-06-12.md` — registro da ultima sessao de hardening
- `DATA_DICTIONARY.md` — descobertas sobre as fontes de dados Metabase
- `docs/METRICS_DEFINITIONS.md` e demais notas em `docs/*.md` — semantica de cada modelo
- `GOTRENDS_V2_MASTER_PROMPT.md` — visao mestra do produto e roadmap original
- `docs/plans/2026-06-10-godeploy-platform-migration.md` — plano da migracao concluida

Para qualquer proxima etapa: leia primeiro `docs/ARCHITECTURE.md`, depois `docs/GUARDRAILS.md` (se mexer em refiners) ou `docs/VERIFICATION.md` (se mexer em verification), e so entao mexa em codigo.
