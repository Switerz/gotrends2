# GoTrends v2 - Backtesting

Sprint 10 cria a primeira camada de log historico e avaliacao das recomendacoes.

## Entregaveis

```text
queries/12_decision_backtest.sql
models/backtesting.py
docs/BACKTESTING.md
```

## Objetivo

Medir se as regras deterministicas teriam gerado boas recomendacoes no passado.

A query simula decisoes por campanha em datas historicas e compara a performance posterior em:

```text
D+1
D+3
D+7
```

## Log de decisoes

Nesta sprint o log e virtual, produzido por `queries/12_decision_backtest.sql`.

Grao:

```text
decision_date + company + campaign_id
```

Campos principais:

```text
decision_date
company
campaign_id
campaign_name
recommended_action
recommended_change_pct
expected_incremental_cost
expected_incremental_revenue
business_constraints_status
constraints_reason
realized_roas_d1
realized_roas_d3
realized_roas_d7
backtest_outcome_d7
recommended_campaign_worsened_d7
```

Quando o fluxo de aprovacao existir, a tabela fisica deve acrescentar:

```text
approval_status
approved_by
approved_at
execution_status
executed_at
actual_change_pct
created_at
```

## Metodologia

As features decisorias usam apenas janelas anteriores a `decision_date`:

```text
pre_cost_7d
pre_conversion_value_7d
pre_roas_7d
cost_28d
proxy_target_roas
confidence_score
impression_share
lost_is_budget
lost_is_rank
```

As janelas futuras sao usadas somente para avaliacao:

```text
realized_cost_d1
realized_conversion_value_d1
realized_roas_d1
realized_cost_d3
realized_conversion_value_d3
realized_roas_d3
realized_cost_d7
realized_conversion_value_d7
realized_roas_d7
```

## Classificacao

`backtest_outcome_d7` usa as regras:

```text
hit
false_positive
false_negative
true_negative
no_followup_data
```

Para `increase_budget`, o resultado e considerado `hit` quando D+7 manteve ROAS pelo menos 95% do ROAS anterior e aumentou gasto vs periodo anterior.

Para `increase_troas_or_reduce_budget`, o resultado e considerado `hit` quando ROAS D+7 ficou pelo menos 5% acima do ROAS anterior.

Para `monitor`, o resultado e `true_negative` se o ROAS D+7 nao cair abaixo de 80% do ROAS anterior; caso contrario, `false_negative`.

## Dashboard simples

`models/backtesting.py` fornece:

```python
summarize_backtest(frame)
outcome_counts(frame)
dashboard_metrics(frame)
```

Cards recomendados:

```text
decisoes avaliadas
recomendacoes candidatas
hit rate
false positive rate
false negative rate
campanhas recomendadas que pioraram
gap medio receita esperada vs realizada
```

Tabelas recomendadas:

```text
outcomes por recommended_action
outcomes por business_constraints_status
top campanhas com maior gap esperado vs realizado
top campanhas recomendadas que pioraram
```

## Limitacoes

- O backtest mede recomendacoes simuladas, nao execucoes reais.
- Nao existe log fisico de aprovacao, execucao ou alteracao efetiva de budget/tROAS.
- `revenue` segue como proxy de `conversion_value`.
- `target_roas`, `budget`, campanhas em aprendizado/teste e bloqueios manuais continuam ausentes.
- Mudancas feitas por humanos ou pelo Google Ads entre D+1 e D+7 podem contaminar o resultado observado.

## Uso

1. Execute `queries/12_decision_backtest.sql` no Metabase ou no banco.
2. Carregue o resultado como lista de dicionarios ou dataframe.
3. Rode:

```python
from models.backtesting import dashboard_metrics, outcome_counts

metrics = dashboard_metrics(rows)
counts = outcome_counts(rows)
```

Use os resultados como avaliacao direcional antes de automatizar qualquer execucao.
