# GoTrends v2 - Google Ads API Integration

Esta integracao adiciona as fontes que faltavam para tirar os principais proxies dos modelos:

```text
budget
target_roas
target_cpa
metricas intraday de Ads
```

## Entregaveis

```text
tools/google_ads_mcp_client.py
tools/export_apice_google_ads.py
tools/load_apice_google_ads_staging.py
tools/apice_enriched_local_smoke.py
tools/build_apice_local_staging.py
queries/13_google_ads_api_staging_contract.sql
docs/GOOGLE_ADS_API_INTEGRATION.md
```

## Conta validada

```text
company: Apice
customer_id: 7705857660
```

O MCP exige `login_customer_id` no arquivo de configuracao do Google Ads. O exportador cria um YAML temporario com esse campo e remove o arquivo temporario ao final.

## Como executar

```powershell
py tools\export_apice_google_ads.py --settings-limit 1000 --hourly-limit 5000
```

Saidas locais:

```text
outputs/apice_google_ads/apice_campaign_settings.csv
outputs/apice_google_ads/apice_hourly_metrics.csv
outputs/apice_google_ads/summary.json
```

`outputs/` esta no `.gitignore`.

## Campaign Settings

Arquivo:

```text
apice_campaign_settings.csv
```

Campos:

```text
customer_id
company
campaign_id
campaign_name
campaign_status
bidding_strategy_type
campaign_budget_resource
budget_amount_micros
budget_brl
budget_period
budget_status
target_roas
target_cpa_micros
target_cpa_brl
```

Validacao em 2026-06-09:

```text
settings_rows: 128
settings_campaigns: 128
ENABLED: 11
PAUSED: 117
budget_gt_0: 128
target_roas_gt_0: 53
target_cpa_gt_0: 6
```

## Hourly Metrics

Arquivo:

```text
apice_hourly_metrics.csv
```

Campos:

```text
customer_id
company
campaign_id
campaign_name
campaign_status
date
hour
cost_micros
cost_brl
impressions
clicks
conversions
conversion_value
```

Validacao com amostra de 1000 linhas em 2026-06-09:

```text
hourly_rows: 1000
hourly_campaigns: 12
dates: 2026-06-04 a 2026-06-08
hours: 0 a 23
distinct_hours: 24
total_cost_brl: 53351.30
total_conversion_value: 715322.09
```

## Impacto nas sprints

| Sprint | Integracao |
|---|---|
| Sprint 1 | `budget`, `target_roas`, `target_cpa` deixam de ser `NULL` quando o staging estiver carregado |
| Sprint 2 | `campaign_hourly_metrics` pode ser implementada com `segments.hour` real |
| Sprint 3 | Baseline pode comparar contra metas reais |
| Sprint 4 | Confiança pode usar estratégia/meta/status reais |
| Sprint 5 | Elasticidade passa a ter budget/meta como contexto |
| Sprint 6 | Saturação troca `proxy_target_roas` por target real quando disponível |
| Sprint 7 | Diagnóstico de alavanca fica mais confiável |
| Sprint 8 | Guardrails de budget e target deixam de depender de proxy |
| Sprint 9 | LLM recebe explicações com metas reais |
| Sprint 10 | Backtest pode comparar recomendações contra configurações reais |

## Proximo passo de banco

Carregar os CSVs ou extrair via job para tabelas de staging:

```text
staging.google_ads_campaign_settings
staging.google_ads_hourly_metrics
```

Depois disso, usar `queries/13_google_ads_api_staging_contract.sql` como contrato para enriquecer as queries existentes.

Tentativa de carga via Metabase em 2026-06-09:

```text
ERROR: cannot execute CREATE SCHEMA in a read-only transaction
```

Ou seja, a permissao atual do Data Mart via Metabase e somente leitura para DDL/DML. O loader esta pronto, mas precisa rodar com usuario/conexao com permissao de escrita.

## Validacao local sem proxy

Enquanto o staging no banco nao existe, `tools/apice_enriched_local_smoke.py` cruza:

```text
Data Mart raw diario
outputs/apice_google_ads/apice_campaign_settings.csv
outputs/apice_google_ads/apice_hourly_metrics.csv
```

Resultado em 2026-06-09:

```text
daily_campaigns: 9
daily_with_budget: 9
daily_with_target_roas: 7
daily_with_target_cpa: 2
daily_without_any_target: 0
latest_hourly_date: 2026-06-08
latest_hourly_rows: 202
latest_hourly_campaigns: 9
latest_hourly_hours: 0 a 23
latest_hourly_cost_brl: 10236.59
latest_hourly_conversion_value: 101993.17
```

Isso valida que, para Apice no ultimo dia observado, os proxies de budget/meta podem ser substituidos localmente pelos dados reais da API.

## Staging local

Como o Data Mart via Metabase esta read-only para escrita, a alternativa operacional atual e montar staging local:

```powershell
py tools\build_apice_local_staging.py
```

Entradas:

```text
Data Mart / raw.gogroup_google_ads
Data Mart / raw.gogroup_google_ads_campaigns
outputs/apice_google_ads/apice_campaign_settings.csv
outputs/apice_google_ads/apice_hourly_metrics.csv
```

Saidas:

```text
outputs/local_staging/apice_campaign_daily_enriched.csv
outputs/local_staging/apice_campaign_hourly_metrics.csv
outputs/local_staging/summary.json
```

Validacao em 2026-06-09:

```text
daily_rows: 4773
daily_campaigns: 68
daily_with_budget: 4551
daily_with_target_roas: 3268
daily_with_target_cpa: 701
latest_daily_date: 2026-06-08
latest_daily_campaigns: 9
latest_daily_with_budget: 9
latest_daily_with_any_target: 9
hourly_rows: 1000
latest_hourly_date: 2026-06-08
latest_hourly_rows: 202
latest_hourly_campaigns: 9
latest_hourly_hours: 0 a 23
```

Esse staging local permite continuar as sprints com dados reais de budget/meta/intraday mesmo sem permissao de escrita no banco.

## Limitacoes

- A integracao atual e local/read-only; ainda nao grava no banco.
- O exportador esta focado em Apice.
- `hourly-limit` limita a amostra retornada; para producao, implementar paginacao ou janelas por dia.
- Search terms e learning/experimentos ainda devem ser extraidos em etapas separadas.
