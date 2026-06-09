# GoTrends v2 - Saturacao e Plato

Sprint 6 classifica campanhas por nivel de saturacao usando retorno marginal, elasticidade e share de impressao.

## Entregaveis

```text
queries/09_saturation_features.sql
models/saturation.py
docs/SATURATION.md
```

## Grao

```text
latest date + company + campaign_id
```

## Inputs

| Campo | Fonte |
|---|---|
| `marginal_roas` | Sprint 5 |
| `elasticity` | Sprint 5 |
| `recommended_spend_band_min` | Sprint 5 |
| `recommended_spend_band_max` | Sprint 5 |
| `impression_share` | `raw.gogroup_google_ads_campaigns.search_impression_share` |
| `lost_is_budget` | `raw.gogroup_google_ads_campaigns.search_budget_lost_impression_share` |
| `lost_is_rank` | `raw.gogroup_google_ads_campaigns.search_rank_lost_impression_share` |
| `forecast_budget_consumption` | `NULL`, porque Sprint 2 esta pendente |

Os campos de share de impressao estao em escala 0-1.

## Target ROAS

`target_roas` nao existe na fonte atual. Para o MVP, a query usa:

```text
proxy_target_roas = COALESCE(campaign_avg_roas, campaign_type_avg_roas)
```

Esse proxy serve apenas para classificar saturacao de forma relativa ao historico. Quando `target_roas` real existir, ele deve substituir o proxy.

## Regras

| Nivel | Regra principal |
|---|---|
| `critical` | `marginal_roas < proxy_target_roas * 0.70` ou elasticidade negativa |
| `high` | `impression_share >= 0.90`, ou `marginal_roas < proxy_target_roas`, ou elasticidade muito baixa |
| `moderate` | `impression_share >= 0.80`, alto `lost_is_rank`, ou elasticidade moderada |
| `low` | Ha espaco relativo para escala |

Regra de negocio preservada:

```text
pure_budget_increase_blocked = impression_share >= 0.90
```

Isso bloqueia aumento puro de budget, mas nao bloqueia recomendacoes de eficiencia, estrutura, termos ou ajuste de target.

## Saidas

| Campo | Uso |
|---|---|
| `saturation_level` | Nivel: `low`, `moderate`, `high`, `critical` |
| `saturation_reason` | Motivo principal da classificacao |
| `pure_budget_increase_blocked` | Bloqueio especifico para aumento puro de budget |
| `recommended_spend_band_min/max` | Faixa de gasto recomendada pela Sprint 5 |

## Limitacoes

- Sem `budget`, nao ha `forecast_budget_consumption`.
- Sem `target_roas`, a comparacao usa proxy historico.
- Michaelis-Menten fica como opcional futuro; nao foi implementado no MVP.
- Saturacao aqui e heuristica e deve ser calibrada com backtesting.

## Validacao

Validacao executada em 2026-06-08 via Metabase API:

| Check | Resultado |
|---|---:|
| Linhas retornadas | 522 |
| Linhas com `marginal_roas` | 522 |
| Linhas com `elasticity` | 521 |
| Linhas com `impression_share` | 309 |
| Linhas com `pure_budget_increase_blocked` | 4 |

Distribuicao de `saturation_level`:

| Nivel | Linhas |
|---|---:|
| `moderate` | 173 |
| `critical` | 160 |
| `low` | 102 |
| `high` | 87 |

Principais motivos:

| Motivo | Linhas |
|---|---:|
| `marginal_roas_far_below_proxy_target` | 150 |
| `high_lost_is_rank` | 134 |
| `room_to_scale` | 102 |
| `marginal_roas_below_proxy_target` | 77 |
| `moderate_elasticity` | 35 |
| `negative_elasticity` | 10 |
| `low_elasticity` | 8 |
| `impression_share_above_80pct` | 4 |
| `impression_share_above_90pct` | 2 |

Validacao Python:

```text
py -m py_compile models/saturation.py
```

O comando compilou o modulo. O ambiente local nao tem `python` funcional no PATH; foi usado o launcher `py`.
