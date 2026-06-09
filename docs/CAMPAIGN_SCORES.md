# GoTrends v2 - Diagnostico de Alavanca e Scores

Sprint 7 combina os sinais diarios ja criados para gerar diagnostico inicial, scores e recomendacao operacional.

## Entregaveis

```text
queries/10_campaign_decision_features.sql
models/lever_diagnosis.py
models/campaign_scores.py
docs/CAMPAIGN_SCORES.md
```

## Grao

```text
latest date + company + campaign_id
```

## Inputs

| Sinal | Origem |
|---|---|
| `current_roas`, `ctr`, `cpc`, `cvr` | camada diaria |
| `roas_7d`, `roas_28d`, `trend_status` | Sprint 3 |
| `confidence_score` | Sprint 4 |
| `marginal_roas`, `elasticity` | Sprint 5 |
| `saturation_level` | Sprint 6 |
| `impression_share`, `lost_is_budget`, `lost_is_rank` | tabela auxiliar de campanhas |

## Diagnostico

`primary_constraint` identifica a principal leitura operacional:

```text
budget_limited
scale_opportunity
efficiency_risk
low_efficiency
saturated
relevance_issue
post_click_issue
monitor
```

`best_lever` e `avoid_lever` traduzem essa leitura em alavancas iniciais.

## Scores

`scale_score`:

```text
0.30 * marginal_roas_score
+ 0.25 * opportunity_score
+ 0.20 * budget_limitation_score
+ 0.15 * confidence_score
+ 0.10 * stability_score
```

`efficiency_risk_score`:

```text
0.35 * roas_below_target_score
+ 0.25 * wasted_spend_score
+ 0.20 * negative_trend_score
+ 0.10 * saturation_score
+ 0.10 * confidence_score
```

`maintenance_score` usa proxies porque ainda nao temos search terms:

```text
lost_is_rank
CTR abaixo do tipo de campanha
CVR abaixo do tipo de campanha
CPC acima do tipo de campanha
```

## Recomendacao

`recommended_action` inicial pode ser:

```text
increase_budget
increase_troas_or_reduce_budget
optimize_efficiency
improve_ads_or_terms
review_landing_or_offer
monitor
```

A recomendacao respeita o bloqueio:

```text
pure_budget_increase_blocked = impression_share >= 0.90
```

Nesse caso, aumento puro de budget vira `optimize_efficiency`.

## Limitacoes

- Sem `target_roas`, usa `proxy_target_roas`.
- Sem `budget`, `budget_limitation_score` usa `lost_is_budget` como proxy.
- Sem search terms, `maintenance_score` ainda nao diagnostica negativa/expansao de termos.
- Sprint 8 ainda precisa aplicar guardrails globais e limites diarios.

## Validacao

Validacao executada em 2026-06-08 via Metabase API:

| Check | Resultado |
|---|---:|
| Linhas retornadas | 522 |
| `scale_score` medio | 40.70 |
| `efficiency_risk_score` medio | 43.74 |
| `maintenance_score` medio | 64.01 |

Distribuicao de `recommended_action`:

| Acao | Linhas |
|---|---:|
| `increase_troas_or_reduce_budget` | 244 |
| `monitor` | 165 |
| `increase_budget` | 79 |
| `improve_ads_or_terms` | 22 |
| `review_landing_or_offer` | 10 |
| `optimize_efficiency` | 2 |

Distribuicao de `primary_constraint`:

| Diagnostico | Linhas |
|---|---:|
| `low_efficiency` | 195 |
| `efficiency_risk` | 128 |
| `scale_opportunity` | 125 |
| `relevance_issue` | 24 |
| `budget_limited` | 19 |
| `monitor` | 19 |
| `post_click_issue` | 10 |
| `saturated` | 2 |

Distribuicao de `risk_level`:

| Risco | Linhas |
|---|---:|
| `high` | 295 |
| `medium` | 154 |
| `low` | 73 |

Validacao Python:

```text
py -m py_compile models/lever_diagnosis.py models/campaign_scores.py
```

O comando compilou os modulos. O ambiente local nao tem `python` funcional no PATH; foi usado o launcher `py`.
