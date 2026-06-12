# GoTrends v2 — Guardrails

> Documento canônico do stack de guardrails do worker TypeScript em
> `app/src/`. O doc anterior (era da era do pipeline Python) está
> arquivado em `legacy/python/` — não consulte para decisões atuais.

## Princípio

Toda recomendação gerada pelo pipeline passa por uma **chain de guardrails**
antes de ser persistida. O verdict final tem três níveis:

| Verdict | Comportamento operacional |
|---|---|
| `ok` | Vai para o Chat como card aprovável diretamente |
| `needs_human_review` | Card aparece com motivo estruturado; humano decide |
| `blocked` | Rec persistida mas **sem** botões no Chat (visível só na SPA) |

Severidade: `blocked > needs_human_review > ok`. Quando múltiplos
guardrails opinam, o mais severo ganha (`mergeVerdicts` em
`agent/refiners/guardrails.ts`).

## Onde cada peça mora

```text
app/src/agent/refiners/
├── guardrails.ts       — applyGuardrails (base) + applyTroasDrift + applyLearningPhase + mergeVerdicts
├── troasDrift.ts       — DB lookup do drift acumulado (queries em executions ⋈ recommendations)
├── biddingLearning.ts  — classifier do bidding_strategy_system_status do Google Ads
├── refine.ts           — orquestra a chain
└── schema.ts           — campos do Candidate (zod)
```

E também:

```text
app/src/pipeline/runModels.ts — chama findActiveByCampaign antes do persistDecision (dedup)
```

## A chain, na ordem

### 1. Hard block — `change_percent > 50%`

Implementado em `guardrails.ts:applyGuardrails`. Bloqueia qualquer rec
cuja mudança proposta supere 50% do valor atual (budget ou tROAS).

Constante: `MAX_ABS_CHANGE_PERCENT = 0.5` em `core/constants.ts`.

Verdict: `blocked` (hard) — não dá para um humano aprovar via Chat.
Justificativa: 50% é um sinal forte de bug no upstream.

### 2. Confiança estatística baixa

`confidence_score < 40` (escala 0-100) → `needs_human_review`.

Constante: `CONFIDENCE_REVIEW_THRESHOLD = 40`.

### 3. Anomalia crítica detectada

Flags `roas_anomaly` ou `cost_anomaly` (vindas do model
`anomalyDetection.ts`) → `needs_human_review`.

### 4. Risco alto

`risk_level === 'high'` → `needs_human_review`.

### 5. Cap diário de drift de tROAS (40%)

Constante: `MAX_DAILY_TROAS_DRIFT = 0.40`.

```text
soma(|Δ tROAS_i / pre_mutate_tROAS_i|) hoje (UTC) + |delta proposto| > 0.40
```

Aplicado **somente** a ações de tROAS (`increase_troas_or_reduce_budget`).
Budget é passivo do ponto de vista do Smart Bidding e não está sujeito.

Implementação:
- `troasDrift.ts:computeTroasDrift` faz 2 queries em
  `executions ⋈ recommendations` somando deltas aplicados
- `guardrails.ts:applyTroasDriftGuardrails` compara com o cap
- `refine.ts` busca o drift via `RefineContext.troasDrift` (injetado por
  `persistDecision`)

Verdict: `needs_human_review`. Motivo carrega o consumido vs cap:

```text
daily_troas_cap (consumed 35%/40%, +10% → 45%)
```

### 6. Cap rolling de 7 dias de tROAS (30%)

Mesma fórmula, janela de 168h, threshold mais apertado.

Constante: `MAX_TROAS_DRIFT_7D = 0.30`.

Por que mais apertado: o algoritmo do Google interpreta swings
cumulativos como instabilidade. ≤30% mantém o modelo aprendido; >30%
re-aprende do zero.

### 7. Learning phase do Smart Bidding

Aplicado **somente** a ações de tROAS.

Lê `campaign.bidding_strategy_system_status` via GAQL (em
`runModels.ts:buildSettingsGaql`) e classifica em 4 estados
(`agent/refiners/biddingLearning.ts`):

| Domain | Raw enum Google Ads (exemplos) | Verdict |
|---|---|---|
| `stable` | `ENABLED` | sem opinião |
| `learning` | `LEARNING_NEW`, `LEARNING_SETTING_CHANGE`, ... | `needs_human_review` |
| `limited` | `LIMITED_BY_BUDGET`, `MISCONFIGURED_*`, ... | `needs_human_review` |
| `unknown` | qualquer outro / vazio | sem opinião |

`unknown` **não bloqueia** — política deliberada de "não opinar sobre
dados que não temos". Operadores podem aprovar com contexto via Chat.

Motivos:

```text
bidding_learning_phase_active — Smart Bidding ainda absorvendo a última mudança
bidding_strategy_limited — campanha limitada por outro fator (budget/bid/quality)
```

### 8. Sweep de stale (12h) — antes do dedup

Implementado em `pipeline/runModels.ts` no **início** de cada run, antes
de qualquer outra coisa.

Recs em `pending` ou `sent_to_chat` com `created_at < now - 12h` são
auto-expiradas (status vai para `expired`). Filosofia: se ninguém engajou
em 12h, o sinal subjacente já mudou — vale gerar uma rec fresh, não
preservar uma decisão velha.

`approved` e `executing` **nunca** são varridos. Eles representam intenção
humana ou mutação em curso; expirá-los mascararia bug em vez de revelar.

Constante: `RECOMMENDATION_STALE_HOURS = 12` em `core/constants.ts`.

Telemetria: contador `nExpiredStale` no `RunResult`. Valor não-zero é
normal e saudável (operador rodou, sistema reciclou). Valor persistente
alto sinaliza saturação da fila de aprovação no Chat.

### 9. Dedup hot-state

Implementado em `pipeline/runModels.ts` **antes** do `persistDecision`,
depois do sweep de stale.

Se já existe rec na mesma `(account_id, campaign_id)` com status em
`{pending, sent_to_chat, approved, executing}` **e não-stale** (o sweep
já tirou as antigas), o candidato é dropado com log estruturado:

```json
{ "event": "skipped_dedup_active_exists", "campaignId": "...", "activeRecommendationId": "...", "activeStatus": "sent_to_chat" }
```

Estados terminais (`executed`, `failed`, `rejected`, `expired`)
**não bloqueiam** — a campanha está livre para nova rec.

Contador `nSkippedDedup` exposto no `RunResult` para visibilidade.

Helper: `RecommendationsRepo.findActiveByCampaign`.

## Tabela de constantes

Todas em `app/src/core/constants.ts`:

| Constante | Valor | Aplicado a |
|---|---:|---|
| `MAX_ABS_CHANGE_PERCENT` | `0.50` | hard block, qualquer ação |
| `CONFIDENCE_REVIEW_THRESHOLD` | `40` | needs_human_review |
| `MAX_DAILY_TROAS_DRIFT` | `0.40` | soft cap diário, tROAS only |
| `MAX_TROAS_DRIFT_7D` | `0.30` | soft cap 7d, tROAS only |
| `RECOMMENDATION_TTL_HOURS` | `24` | expiração default no rec.expires_at |
| `RECOMMENDATION_STALE_HOURS` | `12` | sweep automático de pending/sent_to_chat |

## Por que tROAS e não budget nos caps cumulativos

Decisão do especialista de Google Ads (sessão 2026-06-12):

| Mudança | Impacto entrega | Impacto ROAS | Risco instabilidade |
|---|---|---|---|
| Budget ±50% | Alto (mais spend) | Baixo (~5-10%) | Baixo |
| tROAS −10% | Médio | Médio (~15%) | Médio (sem reset se <±15%) |
| tROAS −30% | Alto (mix muda) | Alto (~30-50%) | Alto (learning reset) |

Budget = constraint passivo (gasta mais, mesmos leilões).
tROAS = signal ativo ao Smart Bidding (muda KW/audience/timing mix).

Caps cumulativos só fazem sentido onde o sistema absorve sinal, não onde
absorve volume.

## Surface no operador

| Onde | O que aparece |
|---|---|
| Chat card (header) | `Aumentar tROAS ou reduzir budget` ou outro label PT-BR |
| Chat card (Guardrail widget) | `OK`, `Revisão humana`, `Bloqueado` |
| SPA detail (badges no topo) | Risk, Guardrail, **Bidding** (learning/limited), **Verificação** (post-execute) |
| SPA detail (Sinais card) | Razão do guardrail + barras de consumo dos caps tROAS |

Verdict de `blocked` é o único que **não** vai pra Chat — operador só vê
na SPA, indicando defesa em profundidade contra rec malformada.

## Override humano

Recs com `needs_human_review` chegam ao Chat com botões. Aprovação humana
**sempre passa**: o executor não re-aplica nenhum guardrail (responsabilidade
do refiner, não do executor).

Auditoria via tabela `approvals` (quem aprovou, quando, via Chat ou SPA).

## O que ainda não tem guardrail

| Cenário | Status atual |
|---|---|
| Listas manuais de bloqueio | Não implementado |
| Detecção de campanhas de teste | Não implementado |
| Limite cumulativo de budget | Decisão explícita: não aplicar |
| Quiet hours (não rodar à noite) | Não implementado |

Adições futuras seguem o padrão: módulo dedicado em `agent/refiners/`,
função sync recebendo Candidate + contexto, retornando
`GuardrailVerdict | null`, composto via `mergeVerdicts` no `refine()`.
