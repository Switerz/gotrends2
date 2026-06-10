# GoTrends v2

Sistema analitico para apoiar decisoes de otimizacao de campanhas de Google Ads da Apice/GoGroup.

O principio do projeto e manter a decisao em uma camada deterministica/estatistica e usar LLM apenas para explicar recomendacoes, riscos e restricoes para aprovacao humana.

## Estrutura do repositorio

O repositorio esta dividido em duas metades durante a migracao para Godeploy:

```text
app/            # Worker TypeScript (em construcao) — este sera o sistema vivo
legacy/python/  # Pipeline Python original — referencia de paridade, nao mais executado em producao
  models/      # Modelos estatisticos (baseline, confianca, elasticidade, saturacao, scores)
  queries/     # SQL de feature engineering e recomendacoes finais
  agent/       # Camada LLM para explicacoes
  tools/       # Scripts de extracao Google Ads / GA4 e smoke tests locais
tools/          # Scripts cross-stack (geracao de fixtures de paridade, etc.) — preenchido durante a migracao
docs/           # Documentacao tecnica
```

A estrutura canonica esta descrita em `docs/ARCHITECTURE.md` — consulte la antes de mover qualquer coisa.

## Onde estou na migracao

O plano ativo e:

```text
docs/plans/2026-06-10-godeploy-platform-migration.md
```

Esse plano define a ordem de tarefas, contratos de dados, e criterios de paridade entre `legacy/python/` e `app/`. Toda mudanca estrutural deve referenciar uma task do plano.

## Status do pipeline original (Python)

Sprint 0 ate Sprint 10 concluidas para a camada local da Apice. Output local separa:

```text
ga4_roas = raw.ga4_gogroup_all_channels.purchase_revenue / cost
ads_roas = Google Ads conversion value / cost
```

O `roas` principal e o ROAS de negocio (`ga4_roas`). Comparacoes com `target_roas` usam `ads_roas`.

A camada Python segue acessivel em `legacy/python/` como fonte de verdade enquanto a paridade com `app/` nao for atingida.

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

- `docs/ARCHITECTURE.md` — estrutura canonica do repo e contratos por camada
- `docs/plans/2026-06-10-godeploy-platform-migration.md` — plano ativo de migracao
- `GOTRENDS_V2_MASTER_PROMPT.md` — visao mestra do produto e roadmap original
- `DATA_DICTIONARY.md` — descobertas sobre as fontes de dados
- `docs/METRICS_DEFINITIONS.md` e demais notas em `docs/*.md` — semantica de cada modelo

Para qualquer proxima etapa: leia primeiro `docs/ARCHITECTURE.md`, depois o plano de migracao, e so entao mexa em codigo.
