# GoTrends v2 — Arquitetura do repositório

> Documento canônico. Toda mudança estrutural passa por aqui antes do código.

## Princípios

1. **Uma decisão, uma camada.** Cada pasta tem uma única responsabilidade. Se um arquivo "faz duas coisas", ele mora errado.
2. **Dependência fluindo numa direção só.** Camada superior pode importar inferior, nunca o contrário.
3. **`models/` é matemática pura.** Zero IO, zero dependência de DB/HTTP/clients.
4. **`agent/` é a única camada que fala com LLM.** Models e pipeline não conhecem LLM.
5. **Pipeline orquestra, não calcula.** Nenhuma fórmula vive em `pipeline/`.
6. **HTTP é boundary.** `http/` traduz JSON ↔ chamadas internas. Não tem lógica de negócio.
7. **Frontend não conhece banco.** `client/` consome apenas `http/`.
8. **Python original isolado em `legacy/python/`.** Vive em paralelo até a paridade fechar.

## Layout

```text
gotrends2/
├── app/                              ← TUDO que roda no Godeploy mora aqui
│   ├── src/                          ← BACKEND (Cloudflare Worker)
│   │   ├── core/                     ← tipos + constantes + erros (sem deps)
│   │   │   ├── types.ts              ← Recommendation, Account, etc.
│   │   │   ├── constants.ts          ← thresholds, tolerâncias
│   │   │   └── errors.ts             ← classes de erro tipadas
│   │   │
│   │   ├── lib/                      ← utilidades genéricas (sem domínio)
│   │   │   ├── stats.ts              ← mean, median, mad, ewma, ols, qcut
│   │   │   ├── df.ts                 ← groupBy, sortBy, leftJoin, rolling
│   │   │   ├── csv.ts                ← parse/stringify
│   │   │   ├── uuid.ts
│   │   │   ├── dates.ts              ← weekday, intervals, timezone
│   │   │   ├── money.ts              ← micros↔BRL, format
│   │   │   └── result.ts             ← Result<T, E>
│   │   │
│   │   ├── models/                   ← MATEMÁTICA DETERMINÍSTICA (port Python)
│   │   │   ├── baselineTrend.ts
│   │   │   ├── anomalyDetection.ts
│   │   │   ├── confidenceScore.ts
│   │   │   ├── marginalElasticity.ts
│   │   │   ├── saturation.ts
│   │   │   ├── leverDiagnosis.ts
│   │   │   ├── campaignScores.ts
│   │   │   ├── constraintsOptimizer.ts
│   │   │   ├── projectedCos.ts
│   │   │   ├── backtesting.ts
│   │   │   └── index.ts              ← barrel
│   │   │
│   │   ├── db/                       ← PERSISTÊNCIA (SQLite via env.DB)
│   │   │   ├── schema.ts             ← DDL multi-conta
│   │   │   ├── bootstrap.ts          ← cria tabelas + seed
│   │   │   ├── types.ts              ← row shapes
│   │   │   └── repos/                ← 1 arquivo por agregado
│   │   │       ├── accounts.ts
│   │   │       ├── runs.ts
│   │   │       ├── recommendations.ts
│   │   │       ├── approvals.ts
│   │   │       ├── executions.ts
│   │   │       ├── outcomes.ts
│   │   │       ├── chatMessages.ts
│   │   │       └── skills.ts
│   │   │
│   │   ├── clients/                  ← INTEGRAÇÕES EXTERNAS
│   │   │   ├── metabase.ts           ← Data Mart
│   │   │   ├── googleAds.ts          ← OAuth2 + GAQL + mutates
│   │   │   ├── googleChat.ts         ← Card v2 + webhook reply
│   │   │   └── llm.ts                ← Anthropic SDK (futuro)
│   │   │
│   │   ├── agent/                    ← CAMADA LLM + SKILLS REGISTRY + REFINER
│   │   │   ├── recommendationAgent.ts ← gera explanation textual (porta de agent/ Python)
│   │   │   ├── prompts/              ← .md/.txt versionados
│   │   │   │   ├── recommendation.md
│   │   │   │   └── weeklyDigest.md
│   │   │   ├── skills/               ← Ryze-style: 1 arquivo por skill
│   │   │   │   ├── registry.ts       ← lista + lookup
│   │   │   │   ├── budgetReallocation.ts
│   │   │   │   ├── anomalyAlert.ts
│   │   │   │   ├── confidenceCheck.ts
│   │   │   │   ├── saturationCheck.ts
│   │   │   │   ├── cpaSpikeDiagnosis.ts
│   │   │   │   ├── guardrailsConstraints.ts
│   │   │   │   ├── projectedCos.ts
│   │   │   │   ├── roasForecast.ts
│   │   │   │   ├── weeklyDigest.ts
│   │   │   │   └── decisionBacktest.ts
│   │   │   ├── refiners/             ← ★ GATE DE INTEGRIDADE: candidate → DB-ready
│   │   │   │   ├── schema.ts         ← Zod: CandidateSchema, RecommendationSchema
│   │   │   │   ├── refine.ts         ← validate → enrich → guardrail → validate
│   │   │   │   ├── enrich.ts         ← derivações (proposed_budget, change_percent, cos)
│   │   │   │   ├── guardrails.ts     ← regras finais (ports constraints_optimizer)
│   │   │   │   └── llm.ts            ← opcional/futuro: LLM refina headline/reason
│   │   │   └── tools/                ← capabilities the agent can call
│   │   │       ├── runModel.ts       ← invoca um modelo
│   │   │       ├── postToChat.ts     ← envia card
│   │   │       ├── executeBudgetChange.ts ← chama Google Ads mutate
│   │   │       └── persistDecision.ts ← grava em recommendations (usa refiner antes)
│   │   │
│   │   ├── pipeline/                 ← ORQUESTRADORES (cron handlers)
│   │   │   ├── runModels.ts          ← daily: fetch → models → recs pending
│   │   │   ├── sendToChat.ts         ← pending → card no Chat → sent_to_chat
│   │   │   ├── computeOutcomes.ts    ← 24h/72h: gather actuals, set verdict
│   │   │   └── weeklyDigest.ts       ← gera markdown semanal
│   │   │
│   │   ├── http/                     ← BOUNDARY HTTP (Hono router)
│   │   │   ├── index.ts              ← root router + bootstrap
│   │   │   ├── middleware.ts         ← auth, cron verify, logging
│   │   │   ├── dto/                  ← shapes que cruzam o boundary
│   │   │   │   ├── recommendation.ts
│   │   │   │   ├── run.ts
│   │   │   │   └── approval.ts
│   │   │   └── routes/               ← 1 arquivo por área
│   │   │       ├── health.ts
│   │   │       ├── runs.ts
│   │   │       ├── recommendations.ts
│   │   │       ├── skills.ts
│   │   │       ├── decisionLog.ts
│   │   │       ├── ingest.ts         ← POST do pipeline Python legado (FASE 1)
│   │   │       ├── chatWebhook.ts    ← /chat/webhook: recebe aprovação
│   │   │       ├── execute.ts        ← /api/execute/:id: dispara mutate
│   │   │       └── cron.ts           ← /cron/* disparados pelo Godeploy
│   │   │
│   │   └── index.ts                  ← Worker entry (fetch handler)
│   │
│   ├── client/                       ← FRONTEND (React SPA bundled pelo Vite)
│   │   ├── main.tsx                  ← entry
│   │   ├── App.tsx                   ← router (react-router)
│   │   ├── pages/                    ← 1 página = 1 rota
│   │   │   ├── Dashboard.tsx
│   │   │   ├── Recommendations.tsx
│   │   │   ├── RecommendationDetail.tsx
│   │   │   ├── Runs.tsx
│   │   │   ├── RunDetail.tsx
│   │   │   ├── Campaign.tsx
│   │   │   ├── Skills.tsx
│   │   │   └── Digest.tsx
│   │   ├── components/
│   │   │   ├── ui/                   ← primitives (Button, Card, Table, Badge)
│   │   │   ├── recommendation/       ← RecommendationCard, FilterBar
│   │   │   ├── chart/                ← Sparkline, TimeSeries
│   │   │   └── layout/               ← Header, Nav, Page
│   │   ├── hooks/
│   │   │   ├── useApi.ts
│   │   │   ├── useRecommendations.ts
│   │   │   └── useRuns.ts
│   │   ├── lib/
│   │   │   ├── api.ts                ← fetch wrappers tipados (compartilha DTOs)
│   │   │   ├── format.ts             ← R$, %, datas
│   │   │   └── filters.ts
│   │   └── styles/
│   │       └── globals.css
│   │
│   ├── tests/                        ← MIRROR de src/ + client/
│   │   ├── lib/
│   │   ├── models/
│   │   ├── db/
│   │   ├── clients/
│   │   ├── agent/
│   │   ├── pipeline/
│   │   ├── http/
│   │   ├── client/
│   │   ├── parity/                   ← gate Python↔TS, tolerância 1e-6
│   │   │   ├── harness.ts
│   │   │   └── *.parity.test.ts
│   │   └── fixtures/
│   │       └── parity/               ← CSVs gerados por tools/
│   │
│   ├── public/                       ← static assets
│   │   └── favicon.ico
│   │
│   ├── index.html                    ← Vite root (SPA shell)
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   ├── vitest.config.ts
│   ├── tailwind.config.ts
│   ├── postcss.config.js
│   ├── .env.example
│   └── README.md
│
├── legacy/                           ← Python original durante migração
│   └── python/
│       ├── models/                   ← (movido de /models)
│       ├── tools/                    ← (movido de /tools, exceto cross-stack)
│       ├── queries/                  ← (movido de /queries)
│       └── agent/                    ← (movido de /agent)
│
├── tools/                            ← scripts CROSS-STACK (gera fixtures etc)
│   ├── generate_parity_fixtures.py   ← Python: gera CSV esperado
│   ├── compare_parity_run.ts         ← TS: roda port e compara
│   └── seed_local_db.ts              ← bootstrap DB local pra dev
│
├── docs/
│   ├── ARCHITECTURE.md               ← este arquivo
│   ├── METRICS_DEFINITIONS.md
│   ├── BASELINE_TREND.md
│   ├── ... (docs existentes)
│   └── plans/
│       └── 2026-06-10-godeploy-platform-migration.md
│
├── GOTRENDS_V2_MASTER_PROMPT.md
├── DATA_DICTIONARY.md
├── README.md                         ← aponta para app/ e legacy/
├── .gitignore
└── .env.example
```

## Regras de dependência (importante)

```text
http/            →  pipeline/, agent/, db/repos, clients/, core/, lib/
pipeline/        →  agent/, models/, db/repos, clients/, core/, lib/
agent/skills/    →  models/, agent/tools/, agent/refiners/, core/, lib/
agent/refiners/  →  core/, lib/             (PURO, valida + enriquece)
agent/tools/     →  models/, db/repos, clients/, agent/refiners/, core/, lib/
agent/recommendationAgent.ts →  core/, lib/  (sem modelos, sem clients)
models/          →  lib/, core/             (PURO, sem db/clients/http)
db/repos/        →  db/types, core/, lib/
db/bootstrap     →  db/schema
clients/         →  core/, lib/             (sem db, sem models)
core/            →  (nada)
lib/             →  (nada além de stdlib)
client/          →  apenas via fetch HTTP, NUNCA importa de src/
```

### O refiner é o ÚNICO caminho de entrada para `recommendations`

Nenhum código deve chamar `RecommendationsRepo.insert()` com um objeto que não tenha passado por `refiners/refine()`. Isso é o que mantém a tabela consistente — todo registro tem os campos corretos, os tipos corretos, e passou pelos guardrails. Quebrar essa regra invalida a auditoria.

Implementação: `tools/persistDecision.ts` chama `refine(candidate)` antes do `repo.insert(...)`. Se algum dia algum outro caller quiser persistir, usa essa tool — não acessa o repo direto.

**Violação dessa direção quebra coesão e impede testar em isolamento.** Lint config opcional pode forçar via `eslint-plugin-boundaries`.

## Skill vs Tool — diferença explícita

| Conceito | Granularidade | Exemplo | Quem chama |
|---|---|---|---|
| **Skill** | capability de negócio (Ryze-style) | "Budget Reallocation" | pipeline ou agent |
| **Tool** | ação atômica chamável | "executar mutate budget" | skill ou agent |

Skill compõe tools + models + prompt. Tool é primitiva: uma ação reversível e idempotente sempre que possível.

Exemplo:
- `skills/budgetReallocation.ts` orquestra: `tools/runModel(marginalElasticity)` → `tools/runModel(constraintsOptimizer)` → gera `Recommendation` → `tools/persistDecision()`. Depois do humano aprovar no Chat, `tools/executeBudgetChange()` aplica.

## Convenções de código

- **TypeScript estrito** com `strict: true` e `noUncheckedIndexedAccess: true`
- **Sem default exports** (exceto entry points), apenas named — força imports explícitos
- **1 export público por arquivo quando faz sentido** (regra de coesão)
- **Testes vivem em `tests/<mirror-path>/`** — não co-located, para manter `src/` limpo
- **Naming**: camelCase para arquivos TS (`baselineTrend.ts`), PascalCase para componentes React (`RecommendationCard.tsx`)
- **Sem barrel exports gigantes** — só onde reduz ruído real (ex: `models/index.ts`)

## Onde NÃO colocar coisas (anti-padrões)

| Tentação | Onde NÃO vai | Onde vai |
|---|---|---|
| "Helper que fala com DB e formata" | `lib/` | quebra em dois: lib/format + db/repos |
| "Modelo que chama Google Ads pra enriquecer" | `models/` | `pipeline/` busca, `models/` recebe pronto |
| "Skill que faz fetch direto" | `agent/skills/` | usa `agent/tools/` ou `pipeline/` |
| "Rota HTTP com cálculo dentro" | `http/routes/` | move pra `pipeline/` ou skill |
| "Componente React que conhece schema do DB" | `client/` | recebe DTO via `lib/api.ts` |

## Estados do repositório durante a migração

| Momento | Python | TS app | Pipeline produtivo |
|---|---|---|---|
| Hoje | em `/models`, `/tools`, `/queries`, `/agent` | inexistente | Python local |
| Após restruct | em `/legacy/python/` | scaffold em `/app/` | Python continua |
| Após FASE 2 | em `/legacy/python/` | 10 modelos paridade ✓ | Python continua |
| Após FASE 7 | em `/legacy/python/` | tudo em Godeploy | TS em Godeploy |
| Aposentadoria | apaga `/legacy/python/` | full TS | TS único |

Aposentar Python = depois de **2 ciclos completos do loop em produção** sem divergência. Não antes.

## Configuração compartilhada (env)

Secrets do Worker (configurados via `setAppSecret`):

```text
# Google Ads
GOOGLE_ADS_DEVELOPER_TOKEN
GOOGLE_ADS_CLIENT_ID
GOOGLE_ADS_CLIENT_SECRET
GOOGLE_ADS_REFRESH_TOKEN
GOOGLE_ADS_LOGIN_CUSTOMER_ID

# Metabase
METABASE_URL
METABASE_API_KEY
METABASE_DATABASE_ID

# Google Chat
GOOGLE_CHAT_WEBHOOK_URL
GOOGLE_CHAT_VERIFICATION_TOKEN

# Internal
INGEST_TOKEN              # auth /api/ingest pelo Python legado
GODEPLOY_CRON_KEY         # injetado pela plataforma
```

`.env.example` na raiz e em `app/` documenta os mesmos sem valores.

## Como adicionar uma nova skill (checklist)

1. Cria `src/agent/skills/<nome>.ts` exportando `run(input, ctx)` que retorna `Candidate[]` (loose)
2. Se precisar de modelo novo, adiciona em `src/models/<nome>.ts` (com paridade Python se houver equivalente)
3. Garante que o output bate com `CandidateSchema` em `agent/refiners/schema.ts` (Zod valida em runtime)
4. Registra em `src/agent/skills/registry.ts`
5. Adiciona seed em `db/schema.ts` (`SEED_SKILLS`)
6. Cria card no Catálogo `client/pages/Skills.tsx`
7. Testes: `tests/agent/skills/<nome>.test.ts`
8. Atualiza `docs/<NOME>.md`

## Tipos: Candidate vs Recommendation

Dois shapes — propositalmente diferentes:

| | `Candidate` (skill output) | `Recommendation` (DB row) |
|---|---|---|
| Onde nasce | `agent/skills/*.run()` | `agent/refiners/refine()` |
| Validação | leve (forma esperada) | estrita (Zod schema da tabela) |
| Campos derivados | parciais (só o que skill calculou) | completos (proposed_budget calculado, etc.) |
| Guardrails | não aplicados | aplicados, `guardrail_status` setado |
| LLM explanation | ausente | preenchida (ou null se feature flag off) |
| Pode ir pro DB? | ❌ | ✅ via `RecommendationsRepo` |

Manter os dois separados evita que skill emita campos incorretos e que o refiner vire um "limpador de bagunça" — o contrato é explícito.

## Como adicionar uma nova tool

1. Cria `src/agent/tools/<nome>.ts` exportando função pura assíncrona
2. Tool recebe `{ db, clients, logger }` como contexto (não importa direto)
3. Testes mocando dependências em `tests/agent/tools/<nome>.test.ts`
4. Lista no `agent/tools/index.ts`
