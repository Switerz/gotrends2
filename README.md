# GoTrends v2

Sistema analitico para apoiar decisoes de otimizacao de campanhas de Google Ads da Apice/GoGroup.

O principio do projeto e manter a decisao em uma camada deterministica/estatistica e usar LLM apenas para explicar recomendacoes, riscos e restricoes para aprovacao humana.

## Status atual

Sprint 0, Sprint 1, Sprint 3, Sprint 4, Sprint 5, Sprint 6, Sprint 7, Sprint 8, Sprint 9 e Sprint 10 concluidas. Sprint 2 permanece pendente por falta de dado horario real.

Roadmap mestre do projeto:

```text
GOTRENDS_V2_MASTER_PROMPT.md
```

Entregaveis criados:

```text
GOTRENDS_V2_MASTER_PROMPT.md
DATA_DICTIONARY.md
queries/00_table_inspection.sql
queries/01_campaign_daily_metrics.sql
queries/02_campaign_hourly_metrics.sql
queries/05_baseline_trend.sql
queries/06_confidence_features.sql
queries/07_spend_bands.sql
queries/08_marginal_roas.sql
queries/09_saturation_features.sql
queries/10_campaign_decision_features.sql
queries/11_final_recommendations.sql
queries/12_decision_backtest.sql
agent/prompts/recommendation_prompt.md
agent/recommendation_agent.py
docs/METRICS_DEFINITIONS.md
docs/BASELINE_TREND.md
docs/CONFIDENCE_SCORE.md
docs/MARGINAL_ELASTICITY.md
docs/SATURATION.md
docs/CAMPAIGN_SCORES.md
docs/GUARDRAILS.md
docs/LLM_AGENT.md
docs/BACKTESTING.md
models/baseline_trend.py
models/anomaly_detection.py
models/confidence_score.py
models/marginal_elasticity.py
models/saturation.py
models/lever_diagnosis.py
models/campaign_scores.py
models/constraints_optimizer.py
models/projected_cos.py
models/backtesting.py
README.md
```

## Fonte de dados confirmada

Banco no Metabase:

```text
Data Mart
```

Tabela principal:

```text
raw.gogroup_google_ads
```

Tabelas auxiliares:

```text
raw.gogroup_google_ads_campaigns
raw.gogroup_google_ads_keywords
```

## Principais conclusoes da Sprint 0

- A tabela principal e diaria, em nivel de anuncio.
- A chave operacional observada e `date + company + campaign_id + ad_group_id + ad_id`.
- Nao existe campo `hour`; portanto o forecast intraday ainda nao pode ser implementado fielmente.
- Existem `campaign_id`, `campaign_name`, `cost`, `revenue`, `impressions`, `clicks` e `conversions`.
- `budget`, `target_roas`, `target_cpa`, `search_term` e indicador de aprendizado nao foram encontrados.
- `status`, `bidding_strategy_type` e share de impressao existem na tabela auxiliar `raw.gogroup_google_ads_campaigns`.

## Proximo passo recomendado

Antes de modelagem intraday:

1. Confirmar se existe outra tabela/fonte com performance horaria.
2. Confirmar onde ficam budget, target ROAS/tCPA e flags de aprendizado/teste.
3. Manter `campaign_hourly_metrics` como pendente ate existir hora real de performance.

Sem essas confirmacoes, o projeto pode seguir para confianca estatistica e demais modelos diarios, mas nao para forecast intraday real.

Para qualquer proxima etapa, leia primeiro `GOTRENDS_V2_MASTER_PROMPT.md` e depois confira as conclusoes atuais em `DATA_DICTIONARY.md`.
