# GoTrends v2 - Modelos Locais Apice

Esta camada executa as sprints com dados reais disponiveis localmente:

```text
Data Mart diario
Data Mart GA4 all channels
Google Ads API campaign settings
Google Ads API hourly metrics
```

Recorte padrao:

```text
date >= 2026-01-01
company = Apice
```

## Execucao

```powershell
py tools\build_apice_local_staging.py
py tools\run_apice_local_models.py
```

## Entregaveis

```text
tools/build_apice_local_staging.py
tools/run_apice_local_models.py
outputs/local_staging/apice_campaign_daily_enriched.csv
outputs/local_staging/apice_campaign_hourly_metrics.csv
outputs/local_models/apice_daily_metrics_2026.csv
outputs/local_models/apice_intraday_forecast.csv
outputs/local_models/apice_campaign_features.csv
outputs/local_models/apice_final_recommendations.csv
outputs/local_models/summary.json
```

## O que deixou de ser proxy

Para Apice, nesta camada local:

```text
budget
target_roas
target_cpa
hour
hourly cost
hourly impressions
hourly clicks
hourly conversions
hourly conversion_value
ga4 purchase_revenue diario por campanha
```

Budget, metas e dados horarios vem da Google Ads API/MCP. Receita GA4 vem de `raw.ga4_gogroup_all_channels`.

## Receita e ROAS

A camada local separa duas leituras:

```text
ads_conversion_value: valor de conversao atribuido no Google Ads
ga4_purchase_revenue: purchase_revenue da raw.ga4_gogroup_all_channels
business_revenue: receita de negocio usada no ROAS executivo, hoje igual ao GA4 purchase_revenue
ads_roas: ads_conversion_value / cost
ga4_roas: ga4_purchase_revenue / cost
roas: ROAS principal de negocio, hoje igual ao ga4_roas
```

O join do GA4 usa:

```text
date + company + lower(trim(campaign_name)) = date + company + lower(trim(campaign))
source = google
medium = cpc
```

As metas `target_roas` sao tratadas como alavanca de otimizacao, nao como corte principal de sucesso. A decisao usa `ga4_roas` contra:

```text
portfolio_segment: institutional, non_brand, brand ou other
segment_roas_reference: mediana de ROAS GA4 do segmento no ultimo dia
min_profitability_roas: piso minimo de rentabilidade
effective_roas_reference: maior valor entre piso minimo e benchmark do segmento
```

Assim campanhas institucionais sao comparadas com institucionais, campanhas NB com NB, e assim por diante. O `ads_roas` permanece no output para leitura tecnica do Google Ads.

## Resultado da execucao

```text
period_start: 2026-01-01
latest_date: 2026-06-08
daily_rows: 1501
latest_campaigns: 9
latest_with_budget: 9
latest_with_target_roas: 7
latest_with_target_cpa: 2
latest_with_ga4_revenue_match: 9
intraday_rows: 9
intraday_campaigns: 9
roas_ga4_2026: 9.42
roas_ads_2026: 13.78
```

Distribuicao de acoes no ultimo dia:

```text
increase_troas_or_reduce_budget: 7
reduce_budget_or_fix_cpa: 2
```

Guardrails:

```text
needs_human_review: 1
blocked: 8
```

O bloqueio acontece porque a regra local permite no maximo uma mudanca de target por dia. A recomendacao prioritaria liberada para revisao humana foi:

```text
shopping-nb
acao: increase_troas_or_reduce_budget
motivo: ROAS Ads abaixo da meta real; ROAS GA4 tambem abaixo da referencia
```

## Como interpretar

Esta camada e mais rigorosa que os modelos anteriores porque compara contra as metas reais atuais da API, nao contra `proxy_target_roas`.

Para o ultimo dia observado, todas as campanhas ativas com performance tinham budget real, alguma meta real e match de receita GA4. Isso permite:

```text
Sprint 1: metricas diarias com budget/target reais e receita GA4
Sprint 2: forecast intraday real de Ads
Sprint 3: tendencia contra meta real
Sprint 6: saturacao com target real
Sprint 7: diagnostico de alavanca com target/budget reais
Sprint 8: guardrails com budget/target reais
```

## Limitacoes

- O historico de budget/tROAS/tCPA ainda nao esta versionado por data; usamos o snapshot atual da API.
- O GA4 entra em grao diario por campanha; o intraday continua usando `metrics.conversions_value` do Google Ads.
- O join com GA4 depende do nome da campanha, pois a tabela `raw.ga4_gogroup_all_channels` nao traz `campaign_id`.
- Learning status, experiment flags e lista manual de bloqueios ainda nao foram integrados.
- Os CSVs locais estao em `outputs/`, portanto nao sao versionados.
