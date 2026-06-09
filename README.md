# GoTrends v2

Sistema analitico para apoiar decisoes de otimizacao de campanhas de Google Ads da Apice/GoGroup.

O principio do projeto e manter a decisao em uma camada deterministica/estatistica e usar LLM apenas para explicar recomendacoes, riscos e restricoes para aprovacao humana.

## Status atual

Sprint 0, Sprint 1, Sprint 2, Sprint 3, Sprint 4, Sprint 5, Sprint 6, Sprint 7, Sprint 8, Sprint 9 e Sprint 10 concluidas para a camada local da Apice.

Atualizacao: o acesso Google Ads API/MCP foi validado para a conta Apice (`7705857660`). Ja existe export local para `budget`, `target_roas`, `target_cpa` e metricas horarias de Ads. A validacao local sem proxy passou; a carga em `staging.*` no banco ficou pendente porque o Data Mart via Metabase retornou transacao read-only para DDL/DML. Como alternativa, `tools/build_apice_local_staging.py` monta um staging local juntando Data Mart Ads + Data Mart GA4 + CSVs da API.

Na camada local Apice, o output agora separa:

```text
ga4_roas = raw.ga4_gogroup_all_channels.purchase_revenue / cost
ads_roas = Google Ads conversion value / cost
```

O `roas` principal do output local e o ROAS de negocio (`ga4_roas`). As comparacoes com `target_roas` continuam usando `ads_roas`.

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
queries/13_google_ads_api_staging_contract.sql
agent/prompts/recommendation_prompt.md
agent/recommendation_agent.py
tools/google_ads_mcp_client.py
tools/export_apice_google_ads.py
tools/load_apice_google_ads_staging.py
tools/apice_enriched_local_smoke.py
tools/build_apice_local_staging.py
tools/run_apice_local_models.py
tools/apice_model_smoke.py
tools/inspect_ga4_gogroup_all_channels.py
docs/METRICS_DEFINITIONS.md
docs/BASELINE_TREND.md
docs/CONFIDENCE_SCORE.md
docs/MARGINAL_ELASTICITY.md
docs/SATURATION.md
docs/CAMPAIGN_SCORES.md
docs/GUARDRAILS.md
docs/LLM_AGENT.md
docs/BACKTESTING.md
docs/GOOGLE_ADS_API_INTEGRATION.md
docs/APICE_LOCAL_MODELS.md
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
raw.ga4_gogroup_all_channels
```

## Principais conclusoes da Sprint 0

- A tabela principal e diaria, em nivel de anuncio.
- A chave operacional observada e `date + company + campaign_id + ad_group_id + ad_id`.
- Nao existe campo `hour` na tabela raw do Data Mart. Para Apice, `hour` real foi validado via Google Ads API.
- Existem `campaign_id`, `campaign_name`, `cost`, `revenue`, `impressions`, `clicks` e `conversions`.
- `raw.ga4_gogroup_all_channels` tem `purchase_revenue` por `date + company + campaign + source + medium` e foi integrada para ROAS de negocio em `source = google` e `medium = cpc`.
- `budget`, `target_roas`, `target_cpa`, `search_term` e indicador de aprendizado nao foram encontrados.
- `status`, `bidding_strategy_type` e share de impressao existem na tabela auxiliar `raw.gogroup_google_ads_campaigns`.

## Proximo passo recomendado

Antes de levar a camada local para producao:

1. Carregar a extracao Google Ads API em staging para `campaign_hourly_metrics` e settings.
2. Carregar ou materializar a agregacao GA4 por campanha/dia em staging.
3. Confirmar flags de aprendizado/teste e bloqueios manuais.

Sem permissao de escrita no Data Mart, esses passos seguem funcionando em staging local dentro de `outputs/`.

Para qualquer proxima etapa, leia primeiro `GOTRENDS_V2_MASTER_PROMPT.md` e depois confira as conclusoes atuais em `DATA_DICTIONARY.md`.
