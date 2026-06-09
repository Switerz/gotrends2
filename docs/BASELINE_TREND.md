# GoTrends v2 - Baseline, Tendencia e Anomalias

Sprint 3 compara cada campanha com seu comportamento historico recente usando a camada diaria da Sprint 1.

## Status da Sprint 2

Sprint 2, forecast intraday, permanece pendente porque a fonte atual nao tem `hour` real de performance. A Sprint 3 segue em base diaria.

## Entregaveis

```text
queries/05_baseline_trend.sql
models/baseline_trend.py
models/anomaly_detection.py
docs/BASELINE_TREND.md
```

## Grao

Todas as saidas mantem:

```text
date + company + campaign_id
```

## Baselines

As janelas usam apenas dias anteriores ao dia avaliado.

| Campo | Definicao |
|---|---|
| `roas_7d` | `conversion_value_7d / cost_7d` |
| `roas_14d` | `conversion_value_14d / cost_14d` |
| `roas_28d` | `conversion_value_28d / cost_28d` |
| `cost_7d` | Soma de custo nos 7 registros diarios anteriores da campanha |
| `cost_14d` | Soma de custo nos 14 registros diarios anteriores da campanha |
| `cost_28d` | Soma de custo nos 28 registros diarios anteriores da campanha |
| `conversion_value_7d` | Soma de valor de conversao nos 7 registros anteriores |
| `conversion_value_14d` | Soma de valor de conversao nos 14 registros anteriores |
| `conversion_value_28d` | Soma de valor de conversao nos 28 registros anteriores |
| `same_weekday_roas` | ROAS agregado das ate 8 ocorrencias anteriores do mesmo dia da semana |
| `ewma_roas` | EWMA de ROAS com alpha inicial de 0.4 |

No SQL, `ewma_roas` usa uma aproximacao ponderada dos ultimos 7 lags para manter a query auditavel e simples. No Python, `ewma_roas` usa `pandas.Series.ewm`.

## Trend status

`trend_status` compara o ROAS do dia com `roas_28d`.

| Status | Regra |
|---|---|
| `strong_positive` | `roas > roas_28d * 1.35` |
| `positive` | `roas > roas_28d * 1.20` |
| `normal` | Entre os limites positivo e negativo |
| `negative` | `roas < roas_28d * 0.80` |
| `strong_negative` | `roas < roas_28d * 0.65` |
| `insufficient_data` | `roas` ou `roas_28d` nulo |

## Anomalias

Anomalias simples usam z-score robusto por MAD em janela historica de 28 dias, excluindo o dia atual.

Metricas avaliadas:

```text
cpc
ctr
cvr
roas
cost
conversions
```

Regra:

```text
robust_z = 0.6745 * (valor_atual - mediana_historica) / MAD
anomalia se abs(robust_z) >= 3.5
```

`critical_anomaly_block` fica verdadeiro quando existe anomalia em `roas`, `cost` ou `conversions`. Esse bloqueio deve ser usado para exigir revisao humana antes de qualquer decisao automatica.

## Limitacoes

- A baseline ainda e diaria, nao intraday.
- Sem `budget`, nao ha leitura de consumo de orcamento.
- Sem `target_roas`/`target_cpa`, a tendencia compara contra historico, nao contra meta declarada.
- Campanhas com pouco historico podem aparecer como `insufficient_data` ou sem anomalias calculadas.
- A query completa com MAD robusto levou cerca de 48s no Metabase; se virar dashboard recorrente, considerar materializar a camada diaria/baseline.

## Validacao

Validacao executada em 2026-06-08 via Metabase API:

| Check | Resultado |
|---|---:|
| Linhas retornadas | 50365 |
| Data minima | 2025-01-01 |
| Data maxima | 2026-06-07 |
| Linhas com `insufficient_data` | 765 |
| Total de flags de anomalia | 13069 |
| Linhas com `critical_anomaly_block` | 6723 |

Distribuicao de `trend_status`:

| Status | Linhas |
|---|---:|
| `normal` | 16224 |
| `strong_negative` | 13331 |
| `strong_positive` | 11272 |
| `negative` | 5282 |
| `positive` | 3491 |
| `insufficient_data` | 765 |

Validacao Python:

```text
py -m py_compile models/baseline_trend.py models/anomaly_detection.py
```

O comando compilou os modulos. O ambiente local nao tem `python` funcional no PATH; foi usado o launcher `py`.
