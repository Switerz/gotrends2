# GoTrends v2 - Guardrails e Otimizador

Sprint 8 seleciona acoes finais respeitando restricoes de negocio disponiveis.

## Entregaveis

```text
queries/11_final_recommendations.sql
models/constraints_optimizer.py
models/projected_cos.py
docs/GUARDRAILS.md
```

## Status importante

Alguns guardrails dependem de fontes ainda ausentes:

```text
budget atual
receita real da empresa
campanhas em aprendizado
campanhas de teste
lista manual de bloqueio
historico de mudancas ja feitas no dia
```

Por isso, a Sprint 8 usa `needs_human_review` como status padrao para acoes que passam nos bloqueios locais, mas ainda dependem dessas fontes externas.

## Guardrails implementados

| Regra | Status |
|---|---|
| Maximo 3 mudancas de budget/dia | Implementado por ranking |
| Maximo 1 mudanca de lance/dia | Implementado por ranking |
| Mudanca de lance ate 20% | Implementado |
| IS >= 90% bloqueia aumento puro de budget | Implementado |
| COS projetado <= 15% | Implementado como proxy, exige revisao |

## Guardrails pendentes

| Regra | Motivo |
|---|---|
| Soma de mudancas de budget ate 40% do investimento inicial | Falta budget/investimento inicial formal |
| Bloquear campanha em aprendizado | Falta flag |
| Bloquear campanha de teste | Falta flag/lista |
| Bloquear campanha manual | Falta lista |
| COS real da empresa | Falta receita real separada |

## COS projetado

Formula:

```text
projected_cos =
  (current_media_cost + expected_incremental_cost)
  /
  (current_revenue + expected_incremental_revenue)
```

No MVP, `current_revenue` usa `conversion_value` como proxy. Quando a receita real/e-commerce/CRM existir, ela deve substituir esse proxy.

## Saida

`queries/11_final_recommendations.sql` retorna:

```text
timestamp
date
company
campaign_id
campaign_name
recommended_action
change_percent
expected_incremental_cost
expected_incremental_revenue
expected_marginal_roas
projected_cos
confidence_score
risk_level
business_constraints_status
constraints_reason
approval_status
execution_status
reason
```

## Validacao

Validacao executada em 2026-06-08 via Metabase API:

| Check | Resultado |
|---|---:|
| Acoes candidatas | 342 |
| Bloqueadas | 187 |
| Necessitam revisao humana | 155 |
| Acoes de budget | 19 |
| Acoes de lance/target | 323 |

Distribuicao por acao e status:

| Acao | Status | Linhas |
|---|---|---:|
| `increase_troas_or_reduce_budget` | `blocked` | 187 |
| `increase_troas_or_reduce_budget` | `needs_human_review` | 136 |
| `increase_budget` | `needs_human_review` | 19 |

Principais razoes:

| Razao | Linhas |
|---|---:|
| `blocked_by_daily_bid_change_limit` | 187 |
| `manual_learning_test_and_real_cos_sources_missing` | 81 |
| `cos_proxy_above_15pct_or_real_cos_missing` | 74 |

Validacao Python:

```text
py -m py_compile models/constraints_optimizer.py models/projected_cos.py
```

O comando compilou os modulos. O ambiente local nao tem `python` funcional no PATH; foi usado o launcher `py`.
