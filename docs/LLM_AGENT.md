# GoTrends v2 - Camada LLM Explicativa

Sprint 9 cria a camada explicativa para transformar recomendacoes estruturadas em texto revisavel por humanos.

## Entregaveis

```text
agent/prompts/recommendation_prompt.md
agent/recommendation_agent.py
docs/LLM_AGENT.md
```

## Principio

A LLM nao decide. A decisao vem das queries/modelos deterministicos.

A LLM deve apenas:

```text
explicar a acao
explicar motivo
explicar impacto esperado
explicar risco e confianca
explicar restricoes checadas
lembrar aprovacao humana
```

## Entrada

A entrada vem de `queries/11_final_recommendations.sql`.

Campos esperados:

```text
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
reason
```

## Saida

`agent/recommendation_agent.py` retorna:

```text
headline
explanation
expected_impact
risk_and_confidence
constraints_checked
approval_note
do_not_execute_reason
```

## Regras de seguranca

- Se `business_constraints_status = blocked`, a explicacao deve dizer que a acao nao deve ser executada.
- Se `business_constraints_status = needs_human_review`, a explicacao deve tratar como candidata, nao como execucao.
- Campos nulos devem ser descritos como indisponiveis.
- Nao criar metricas ou justificativas fora do payload.

## Uso

O modulo Python possui duas funcoes principais:

```python
payload = build_llm_payload(row)
explanation = explain_recommendation(payload)
```

`explain_recommendation` e deterministico e serve como fallback ou baseline. Quando uma LLM for conectada, ela deve receber `payload` e obedecer a `agent/prompts/recommendation_prompt.md`.
