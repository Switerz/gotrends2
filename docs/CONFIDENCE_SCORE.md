# GoTrends v2 - Confidence Score

Sprint 4 cria uma heuristica inicial de confianca estatistica para evitar decisoes com pouco dado.

## Entregaveis

```text
queries/06_confidence_features.sql
models/confidence_score.py
docs/CONFIDENCE_SCORE.md
```

## Grao

```text
date + company + campaign_id
```

A query usa apenas dias anteriores ao dia avaliado. O dia atual nao entra no proprio lookback.

## Features de entrada

| Campo | Definicao |
|---|---|
| `cost_28d` | Soma de custo nos 28 registros diarios anteriores |
| `clicks_28d` | Soma de cliques nos 28 registros diarios anteriores |
| `conversions_28d` | Soma de conversoes nos 28 registros diarios anteriores |
| `conversion_value_28d` | Soma de valor de conversao nos 28 registros diarios anteriores |
| `days_with_spend_28d` | Quantidade de dias anteriores com custo maior que zero |
| `roas_observations_28d` | Quantidade de observacoes validas de ROAS no lookback |
| `avg_roas_28d` | Media simples de ROAS diario no lookback |
| `stddev_roas_28d` | Desvio padrao amostral de ROAS diario no lookback |
| `roas_cv_28d` | Coeficiente de variacao de ROAS: `stddev_roas_28d / abs(avg_roas_28d)` |

## Score

O score vai de 0 a 100.

| Componente | Regra |
|---|---|
| `cost_score` | Ate 25 pontos; maximo quando `cost_28d >= 1000` |
| `clicks_score` | Ate 25 pontos; maximo quando `clicks_28d >= 500` |
| `conversions_score` | Ate 25 pontos; maximo quando `conversions_28d >= 20` |
| `spend_days_score` | Ate 25 pontos; maximo quando `days_with_spend_28d >= 14` |
| `volatility_penalty` | Penalidade de 0 a 25 por ROAS muito volatil |

Formula:

```text
confidence_score =
  cost_score
  + clicks_score
  + conversions_score
  + spend_days_score
  - volatility_penalty
```

Depois o valor e arredondado e limitado entre 0 e 100.

## Thresholds

| Faixa | Regra |
|---|---|
| `high` | `confidence_score >= 75` |
| `medium` | `confidence_score >= 60` e menor que 75 |
| `low` | `confidence_score >= 40` e menor que 60 |
| `insufficient` | menor que 40 |

Regras operacionais:

```text
allow_budget_increase = confidence_score >= 60
allow_aggressive_action = confidence_score >= 75
```

## Bootstrap

`models/confidence_score.py` inclui `bootstrap_roas` como opcional para estimar:

```text
roas_p10
roas_p50
roas_p90
```

No MVP, o bootstrap fica disponivel para analises e backtests, mas nao e exigido pela query SQL.

## Limitacoes

- Thresholds iniciais sao heuristica; devem ser calibrados com backtesting.
- Sem metas declaradas (`target_roas`/`target_cpa`), a confianca mede estabilidade/volume, nao qualidade contra meta.
- Campanhas recentes tendem a ter `confidence_score` baixo por desenho.
- ROAS com poucos dias validos recebe penalidade de volatilidade.
- A distribuicao inicial ficou concentrada em `high`, sinal de que os thresholds de volume devem ser revisitados apos backtesting.

## Validacao

Validacao executada em 2026-06-08 via Metabase API:

| Check | Resultado |
|---|---:|
| Linhas retornadas | 50365 |
| Data minima | 2025-01-01 |
| Data maxima | 2026-06-07 |
| Confidence minimo | 0 |
| Confidence maximo | 100 |
| Confidence medio | 86.32 |
| Linhas com `allow_budget_increase` | 43883 |
| Linhas com `allow_aggressive_action` | 41807 |

Distribuicao de `data_sufficiency`:

| Faixa | Linhas | Confidence medio |
|---|---:|---:|
| `high` | 41807 | 96.61 |
| `insufficient` | 4153 | 12.98 |
| `low` | 2329 | 50.24 |
| `medium` | 2076 | 66.27 |

Validacao Python:

```text
py -m py_compile models/confidence_score.py
```

O comando compilou o modulo. O ambiente local nao tem `python` funcional no PATH; foi usado o launcher `py`.
