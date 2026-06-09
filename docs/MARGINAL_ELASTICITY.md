# GoTrends v2 - Elasticidade Marginal

Sprint 5 estima o retorno incremental esperado de mais investimento usando faixas historicas de gasto diario.

## Entregaveis

```text
queries/07_spend_bands.sql
queries/08_marginal_roas.sql
models/marginal_elasticity.py
docs/MARGINAL_ELASTICITY.md
```

## Graos

`queries/07_spend_bands.sql`:

```text
model_level + company + campaign_id/campaign_type + spend_band
```

`queries/08_marginal_roas.sql`:

```text
latest date + company + campaign_id
```

## Metodo

1. Agrega a fonte diaria por campanha.
2. Mantem apenas dias com `cost > 0`.
3. Divide o historico de gasto diario em 4 faixas com `NTILE(4)`.
4. Calcula gasto medio e receita media por faixa.
5. Calcula retorno incremental entre faixas adjacentes:

```text
marginal_roas =
  (avg_conversion_value_band_n - avg_conversion_value_band_n-1)
  /
  (avg_cost_band_n - avg_cost_band_n-1)
```

6. Estima elasticidade log-log quando ha dados positivos:

```text
ln(conversion_value) = alpha + beta * ln(cost)
elasticity = beta
```

## Fallback

`queries/08_marginal_roas.sql` usa modelo por campanha quando:

```text
days_with_spend >= 28
positive_revenue_days >= 14
campaign marginal_roas is not null
```

Caso contrario, usa fallback por:

```text
company + campaign_type
```

## Interpretacao

| Campo | Como usar |
|---|---|
| `marginal_roas` | Retorno esperado do proximo patamar de gasto |
| `elasticity` | Sensibilidade historica da receita ao gasto |
| `recommended_spend_band_min` | Limite inferior da faixa recomendada |
| `recommended_spend_band_max` | Limite superior da faixa recomendada |
| `model_level_used` | Indica se a estimativa veio de campanha ou fallback por tipo |

Elasticidade:

| Valor | Leitura |
|---|---|
| `> 1` | Receita cresceu mais que proporcionalmente ao gasto no historico |
| `0 a 1` | Receita cresceu menos que proporcionalmente |
| proximo de `0` | Pouca resposta incremental |
| negativo | Historico sugere piora quando gasto aumenta |

## Limitacoes

- Este MVP e historico/descritivo; nao prova causalidade.
- As faixas por `NTILE(4)` sao relativas ao historico da campanha, nao faixas fixas de budget.
- Sem `target_roas`, ainda nao ha comparacao direta contra meta.
- Campanhas com pouco historico usam fallback por `campaign_type`, que e menos especifico.
- ROAS marginal pode ficar negativo quando a faixa seguinte teve mais gasto e menos receita media.

## Validacao

Validacao executada em 2026-06-08 via Metabase API.

`queries/07_spend_bands.sql`:

| `model_level` | Linhas | Linhas com `marginal_roas` |
|---|---:|---:|
| `campaign` | 2050 | 1528 |
| `campaign_type` | 148 | 111 |

`queries/08_marginal_roas.sql`:

| Check | Resultado |
|---|---:|
| Linhas retornadas | 522 |
| Linhas com `marginal_roas` | 522 |
| Linhas com `elasticity` | 521 |
| Modelo por campanha | 114 |
| Fallback por `campaign_type` | 408 |
| `marginal_roas` medio | 5.62 |
| `elasticity` media | 0.92 |

Validacao Python:

```text
py -m py_compile models/marginal_elasticity.py
```

O comando compilou o modulo. O ambiente local nao tem `python` funcional no PATH; foi usado o launcher `py`.
