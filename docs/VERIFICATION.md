# GoTrends v2 — Post-execute verification

> Confirmar que um mutate aplicado no Google Ads realmente persistiu,
> detectando rollbacks manuais e races com outros operadores.

## Problema

O executor recebe um 200 OK do Google Ads e considera a mutação
aplicada. Duas falhas reais que esse 200 não revela:

1. **Rollback manual.** Operador (ou outro tool) reverte o valor via UI
   do Google Ads pouco depois do mutate.
2. **Race com mutate concorrente.** Outro job grava valor diferente em
   sequência.

Em ambos os casos, a recomendação fica marcada como `executed` no nosso
DB, o operador acredita que a campanha está naquele estado, mas o Google
Ads está em outro valor. Sem verificação, descobrir isso só acontece via
queda de performance + investigação manual.

## Mecanismo

Cron de **6 em 6 horas** (`/cron/verify-executions`, job
`sxeyk0ps2h4r` no Godeploy) percorre execuções `success` que ainda não
foram verificadas e cujo `completed_at` cai numa janela de **2h–24h**
atrás:

```text
Lower bound 2h  → Smart Bidding precisa absorver antes de ler valor
Upper bound 24h → após 24h, divergências viram ruído de operações
                  posteriores, não respondem "o mutate pegou?"
```

Para cada execução elegível:

1. **GAQL único** lê estado vivo da campanha
   (`campaign.maximize_conversion_value.target_roas` e
   `campaign_budget.amount_micros`)
2. **Classifica** a discrepância em 4 estados (ver tabela abaixo)
3. **Persiste** `verified_at`, `verification_status`, `verified_value`
   nas colunas adicionadas à tabela `executions`

A linha é settled — não é re-verificada (verification é best-effort).

## Estados

| Estado | Critério | Ação operacional |
|---|---|---|
| `match` | \|Δ\| ≤ 1% | nenhuma — mutate pegou |
| `drifted` | 1% < \|Δ\| ≤ 10% | investigar — possível race ou rounding |
| `reverted` | \|Δ\| > 10% | atenção — possível rollback manual; loud log dispara |
| `unavailable` | network/campanha removida/campo ausente | nenhum retry; settled |

Tolerâncias em `agent/verification/executionVerification.ts`:

```ts
const MATCH_TOLERANCE = 0.01  // 1%
const DRIFT_TOLERANCE = 0.10  // 10%
```

## Arquitetura (3 camadas independentes)

```text
app/src/agent/verification/executionVerification.ts
  └─ verifyExecution(ads, customerId, exec, rec): VerificationResult
     • pura (sem DB write)
     • GAQL via GoogleAdsClient (mockável em testes)
     • erro → 'unavailable' (nunca propaga)

app/src/db/repos/executions.ts
  ├─ findUnverifiedInBand(from, to, limit)
  │  • status='success' AND verified_at IS NULL AND completed_at IN band
  │  • ORDER BY completed_at ASC (mais antigos primeiro)
  └─ markVerified(execId, nowIso, status, observedValue)
     • UPDATE — sempre stampa verified_at, mesmo em 'unavailable'

app/src/http/routes/cron.ts:verifyPendingExecutions
  • orquestrador: lista pending + chama verifier + persiste
  • counter por status (debug)
  • loud log estruturado quando status='reverted'
```

## Loud log de reverted

Toda vez que detectamos um rollback, emitimos:

```json
{
  "event": "execution_reverted",
  "execution_id": "...",
  "recommendation_id": "...",
  "campaign_id": "...",
  "proposed": 5.5,
  "observed": 3.8,
  "action": "increase_troas_or_reduce_budget"
}
```

Acessível via `getAppLogs` do Godeploy ou query direta na tabela
`executions WHERE verification_status = 'reverted'`.

## Schema

Três colunas em `executions`, com migration idempotente
(`MIGRATIONS` array em `db/schema.ts`):

```sql
ALTER TABLE executions ADD COLUMN verified_at TEXT;
ALTER TABLE executions ADD COLUMN verification_status TEXT;
ALTER TABLE executions ADD COLUMN verified_value REAL;
```

Linhas pré-migration carregam `NULL` em todas as três — o cron passa por
cima delas sem retry.

## Surface no operador

| Onde | O que aparece |
|---|---|
| SPA detail (badge no topo) | `Verificação: aplicado / drift detectado / revertido / não verificável` |
| API `/api/recommendations/:id` | `verification: {status, observedValue, verifiedAt}` |
| DB | `executions.verification_status`, `executions.verified_value` |
| Logs | `execution_reverted` event (apenas em reverts) |

Cor do badge segue `verificationTone` em
`client/components/ui/Badge.tsx`:
- sage (`match`)
- amber (`drifted`)
- coral (`reverted`)
- neutral (`unavailable`)

## Limitações conhecidas

1. **GAQL custa quota.** Cada verification = 1 GAQL. Em produção com
   muitas execuções, considerar batching `WHERE campaign.id IN (...)`.
2. **Não captura mudança APÓS verification.** Verificamos uma vez, em
   2h–24h. Reversão no dia seguinte não é detectada.
3. **Tolerâncias fixas.** 1% / 10% funcionam para tROAS (3.0–10.0) e
   budgets BRL. Se aparecerem campanhas com tROAS muito pequeno (~0.5),
   o "1%" vira ruído numérico — revisitar se houver falsos positivos.
4. **Não verifica `failed` ou `pending`.** Apenas execuções com `status =
   'success'`. Recs que falharam no executor (`mutate_failed` /
   `precondition_failed`) não passam por aqui.

## Como invocar manualmente

```bash
source .env
curl -X POST https://gotrends-agent.devgogroup.com/api/admin/trigger/verify-executions \
  -H "X-Ingest-Token: $INGEST_TOKEN"
```

Resposta:

```json
{
  "verified": 3,
  "skipped": 0,
  "counts": { "match": 2, "drifted": 1, "reverted": 0, "unavailable": 0 },
  "errors": []
}
```
