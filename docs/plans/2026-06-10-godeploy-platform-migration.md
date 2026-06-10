# GoTrends v2 — Godeploy Platform Migration Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrar GoTrends v2 do pipeline Python/CSV local para uma plataforma agentica completa rodando em um Cloudflare Worker no Godeploy, com loop fechado de recomendação → Google Chat → aprovação → execução no Google Ads → outcome 24/72h, multi-conta desde o início, com paridade numérica obrigatória contra os modelos Python.

**Architecture:** 1 Cloudflare Worker no Godeploy contendo: (a) SQLite embutida (`env.DB`) com schema multi-conta, (b) pipeline orquestrador em TS chamado por cron, (c) clientes para Metabase e Google Ads API (OAuth2 + GAQL + mutate), (d) webhook do Google Chat para aprovação, (e) executor que aplica mutate no Google Ads após aprovação, (f) SPA React no mesmo Worker para auditoria. Python original permanece no repositório como **referência canônica de paridade**, nunca apagado durante a migração; só é aposentado quando todos os 10 modelos passarem o teste de paridade com tolerância 1e-6.

**Tech Stack:**
- Runtime: Cloudflare Workers (Godeploy), TypeScript, Hono router
- Storage: SQLite embutida (`env.DB.exec` / `env.DB.query`)
- Frontend: React 18 + Vite + Tailwind (bundled como `client` no Godeploy)
- Tests: Vitest + parity harness em Node contra fixtures Python
- Integrações: Google Ads API REST v18, Google Chat HTTP API, Metabase API
- Cron: Godeploy `createCronJob` (POST agendado pela plataforma)

---

## Convenções do plano

- **Branch:** `feat/godeploy-platform` (já criada)
- **Arquitetura canônica:** `docs/ARCHITECTURE.md` — toda decisão estrutural passa por lá
- **App diretório raiz:** `/home/pedrorocha/gotrends2/app/` (camadas: `src/{core,lib,models,db,clients,agent,pipeline,http}` + `client/` + `tests/`)
- **Python original isolado em** `legacy/python/{models,tools,queries,agent}` durante a migração (movido na Task 0.0)
- **Cada modelo portado tem teste de paridade obrigatório** antes do commit final daquele modelo
- **Tolerância numérica de paridade:** `1e-6` em todos os campos float; igualdade exata em campos string/bool/int
- **Commits frequentes:** após cada Step de "passar teste" ou "implementação verde"
- **Conventional commits:** `feat:`, `test:`, `chore:`, `fix:`, `docs:`

---

## Fixtures de paridade (input compartilhado Python ↔ TS)

Antes de qualquer port, geramos um conjunto canônico de CSVs de entrada + os outputs esperados de cada modelo Python. TS roda contra os mesmos CSVs e comparamos campo a campo.

Diretório: `/home/pedrorocha/gotrends2/app/tests/fixtures/parity/`

```text
input_apice_daily.csv               # subset dataset Apice
input_apice_hourly.csv
expected_baseline_trend.csv         # output de models.baseline_trend
expected_anomaly_detection.csv
expected_confidence_score.csv
expected_marginal_elasticity.csv
expected_saturation.csv
expected_lever_diagnosis.csv
expected_campaign_scores.csv
expected_constraints_optimizer.csv
expected_projected_cos.csv
expected_backtesting.json
```

Cada fixture é regenerada por `tools/generate_parity_fixtures.py` (vamos criar). Isso garante que se alguém atualizar o Python, as fixtures atualizam e os testes TS precisam empatar de novo.

---

# FASE 0 — Setup do worktree e tooling

## Task 0.0: Reorganizar repositório conforme `docs/ARCHITECTURE.md`

**Por que:** antes de qualquer código TS, o Python original precisa sair de `/models`, `/tools`, `/queries`, `/agent` para `legacy/python/` — garante que durante a migração ninguém confunda "código vivo" com "referência de paridade".

**Files:**
- Move: `models/` → `legacy/python/models/`
- Move: `queries/` → `legacy/python/queries/`
- Move: `agent/` → `legacy/python/agent/`
- Move: `tools/{run_apice_local_models.py, apice_model_smoke.py, apice_enriched_local_smoke.py, build_apice_local_staging.py, generate_apice_final_report.py, analyze_apice_account_2026.py, load_apice_google_ads_staging.py, export_apice_change_history.py, export_apice_google_ads.py, google_ads_mcp_client.py, inspect_ga4_gogroup_all_channels.py}` → `legacy/python/tools/`
- Mantém em `/tools/` (raiz): apenas scripts cross-stack que vamos criar (`generate_parity_fixtures.py`)
- Modify: `README.md` (raiz) → apontar para `app/`, `legacy/python/`, e `docs/ARCHITECTURE.md`

**Step 1: Mover diretórios**

```bash
cd /home/pedrorocha/gotrends2
mkdir -p legacy/python
git mv models legacy/python/models
git mv queries legacy/python/queries
git mv agent legacy/python/agent
mkdir -p legacy/python/tools
git mv tools legacy/python/tools_tmp
# manter raiz /tools vazia por enquanto (vai ganhar generate_parity_fixtures.py na Task 0.4)
mkdir -p tools
mv legacy/python/tools_tmp/* legacy/python/tools/
rmdir legacy/python/tools_tmp
```

**Step 2: Ajustar README raiz**

Atualizar para mencionar:
- `app/` — código novo TS/Worker
- `legacy/python/` — referência de paridade
- `docs/ARCHITECTURE.md` — leitura obrigatória antes de mexer

**Step 3: Verificar que nada quebrou**

```bash
ls legacy/python/{models,queries,agent,tools}
ls app/  # ainda só src/, public/ do scaffold inicial
```

Expected: estruturas existem, raiz limpa.

**Step 4: Commit**

```bash
git add -A
git commit -m "chore: relocate Python pipeline to legacy/python/ per ARCHITECTURE.md"
```

---

## Task 0.1: Criar estrutura base da app

**Files:**
- Create: `app/package.json`
- Create: `app/tsconfig.json`
- Create: `app/vitest.config.ts`
- Create: `app/.gitignore`
- Create: `app/README.md`

**Step 1: Criar package.json**

```json
{
  "name": "gotrends-agent",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:parity": "vitest run tests/parity",
    "typecheck": "tsc --noEmit",
    "build:client": "vite build",
    "dev": "vite"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@cloudflare/workers-types": "^4.20251001.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.3",
    "csv-parse": "^5.5.6",
    "csv-stringify": "^6.5.1",
    "typescript": "^5.6.3",
    "vite": "^5.4.10",
    "vitest": "^2.1.4"
  }
}
```

**Step 2: Criar tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["@cloudflare/workers-types", "vitest/globals"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "client", "tests"]
}
```

**Step 3: Criar vitest.config.ts**

```ts
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: { alias: { '@': '/src' } },
})
```

**Step 4: Criar .gitignore**

```text
node_modules
dist
.wrangler
.env
.env.local
*.log
```

**Step 5: Instalar deps**

```bash
cd /home/pedrorocha/gotrends2/app && npm install
```

Expected: `npm install` completes without errors. `node_modules` populated.

**Step 6: Commit**

```bash
git add app/package.json app/package-lock.json app/tsconfig.json app/vitest.config.ts app/.gitignore app/README.md
git commit -m "chore: scaffold app/ worker package with hono, vitest, react"
```

---

## Task 0.2: Helpers numéricos compartilhados (stats core)

**Por que existe:** quase todo modelo precisa de mean, median, MAD, EWMA, OLS, quantile bucketing. Em vez de re-implementar em cada modelo, centralizamos.

**Files:**
- Create: `app/src/lib/stats.ts`
- Create: `app/tests/lib/stats.test.ts`

**Step 1: Escrever o teste primeiro**

```ts
// tests/lib/stats.test.ts
import { describe, it, expect } from 'vitest'
import { mean, median, mad, ewma, olsSlope, qcutRanks } from '@/lib/stats'

describe('stats', () => {
  it('mean ignores null/NaN', () => {
    expect(mean([1, 2, 3, null, NaN])).toBeCloseTo(2, 12)
  })

  it('median odd & even', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
  })

  it('mad = median absolute deviation', () => {
    expect(mad([1, 1, 2, 2, 4, 6, 9])).toBe(1)
  })

  it('ewma matches pandas .ewm(alpha=0.4, adjust=False)', () => {
    // values: [10, 12, 14], alpha=0.4
    // s0=10; s1=0.4*12+0.6*10=10.8; s2=0.4*14+0.6*10.8=12.08
    const out = ewma([10, 12, 14], 0.4)
    expect(out[0]).toBeCloseTo(10, 12)
    expect(out[1]!).toBeCloseTo(10.8, 12)
    expect(out[2]!).toBeCloseTo(12.08, 12)
  })

  it('olsSlope returns slope of log(y) = a + b·log(x)', () => {
    const x = [1, 2, 4, 8]
    const y = [2, 4, 8, 16]
    // log-log slope should be ~1
    const slope = olsSlope(x.map(Math.log), y.map(Math.log))
    expect(slope).toBeCloseTo(1, 10)
  })

  it('qcutRanks equal-count bucketing (pandas qcut on rank)', () => {
    const vals = [10, 20, 30, 40, 50, 60, 70, 80]
    // 4 bands → [1,1,2,2,3,3,4,4]
    expect(qcutRanks(vals, 4)).toEqual([1, 1, 2, 2, 3, 3, 4, 4])
  })
})
```

**Step 2: Rodar para confirmar que falha**

```bash
cd app && npm run test -- tests/lib/stats.test.ts
```

Expected: FAIL — `Cannot find module '@/lib/stats'`.

**Step 3: Implementar src/lib/stats.ts**

```ts
// src/lib/stats.ts
export function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x)
}

export function clean(values: Array<number | null | undefined>): number[] {
  return values.filter(isFiniteNumber) as number[]
}

export function mean(values: Array<number | null | undefined>): number {
  const c = clean(values)
  if (c.length === 0) return NaN
  return c.reduce((a, b) => a + b, 0) / c.length
}

export function median(values: Array<number | null | undefined>): number {
  const c = clean(values).slice().sort((a, b) => a - b)
  if (c.length === 0) return NaN
  const m = Math.floor(c.length / 2)
  return c.length % 2 ? c[m]! : (c[m - 1]! + c[m]!) / 2
}

export function mad(values: Array<number | null | undefined>): number {
  const c = clean(values)
  if (c.length === 0) return NaN
  const med = median(c)
  return median(c.map(v => Math.abs(v - med)))
}

/** EWMA equivalent to pandas .ewm(alpha=α, adjust=False).mean(): s_t = α·x_t + (1-α)·s_{t-1} */
export function ewma(values: Array<number | null | undefined>, alpha: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN)
  let s: number | null = null
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (!isFiniteNumber(v)) { out[i] = s ?? NaN; continue }
    s = s === null ? v : alpha * v + (1 - alpha) * s
    out[i] = s
  }
  return out
}

/** Slope of OLS y = a + b·x. Returns NaN if var(x) is ~0 or n < 3. */
export function olsSlope(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) return NaN
  const xb = mean(x), yb = mean(y)
  let num = 0, den = 0
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - xb
    num += dx * (y[i]! - yb)
    den += dx * dx
  }
  if (den < 1e-12) return NaN
  return num / den
}

/** pandas.qcut(rank(method='first'), n_bands, labels=False, duplicates='drop').add(1).
 *  Returns the 1-based band index per element preserving original order. */
export function qcutRanks(values: number[], nBands: number): number[] {
  if (values.length === 0) return []
  if (values.length === 1) return [1]
  const bands = Math.min(nBands, values.length)
  // rank(method='first'): rank by value, ties broken by original index
  const ranked = values
    .map((v, i) => ({ v, i }))
    .sort((a, b) => a.v - b.v || a.i - b.i)
    .map((o, rank) => ({ ...o, rank: rank + 1 }))
  // assign each rank to a band using equal-count split (qcut semantics)
  const bucketed = ranked.map(o => ({
    i: o.i,
    band: Math.min(bands, Math.floor(((o.rank - 1) * bands) / values.length) + 1),
  }))
  bucketed.sort((a, b) => a.i - b.i)
  return bucketed.map(b => b.band)
}
```

**Step 4: Rodar testes para confirmar PASS**

```bash
cd app && npm run test -- tests/lib/stats.test.ts
```

Expected: PASS (6 tests).

**Step 5: Commit**

```bash
git add app/src/lib/stats.ts app/tests/lib/stats.test.ts
git commit -m "feat(stats): add mean/median/mad/ewma/olsSlope/qcutRanks helpers"
```

---

## Task 0.3: DataFrame-lite helpers (groupby, sort, join)

**Por que existe:** vamos imitar `pd.groupby().agg()` e `pd.merge()` em TS sem trazer Arquero (dep extra). Mantém minimalista.

**Files:**
- Create: `app/src/lib/df.ts`
- Create: `app/tests/lib/df.test.ts`

**Step 1: Escrever o teste**

```ts
import { describe, it, expect } from 'vitest'
import { groupBy, sortBy, leftJoin, rollingSumPriorOnly } from '@/lib/df'

describe('df', () => {
  it('groupBy by composite key', () => {
    const rows = [
      { co: 'A', cid: 1, v: 10 },
      { co: 'A', cid: 1, v: 20 },
      { co: 'A', cid: 2, v: 30 },
      { co: 'B', cid: 1, v: 40 },
    ]
    const g = groupBy(rows, r => `${r.co}|${r.cid}`)
    expect(g.size).toBe(3)
    expect(g.get('A|1')!.length).toBe(2)
  })

  it('sortBy ascending by key', () => {
    const rows = [{ d: '2026-01-03' }, { d: '2026-01-01' }, { d: '2026-01-02' }]
    expect(sortBy(rows, r => r.d).map(r => r.d))
      .toEqual(['2026-01-01', '2026-01-02', '2026-01-03'])
  })

  it('leftJoin matches and preserves left order', () => {
    const left = [{ k: 1, a: 'x' }, { k: 2, a: 'y' }]
    const right = [{ k: 2, b: 'B' }, { k: 1, b: 'A' }]
    const joined = leftJoin(left, right, l => `${l.k}`, r => `${r.k}`)
    expect(joined).toEqual([
      { k: 1, a: 'x', b: 'A' },
      { k: 2, a: 'y', b: 'B' },
    ])
  })

  it('rollingSumPriorOnly excludes current row (shift(1).rolling(window).sum)', () => {
    // matches pandas: s.shift(1).rolling(3, min_periods=1).sum()
    expect(rollingSumPriorOnly([10, 20, 30, 40, 50], 3))
      .toEqual([0, 10, 30, 60, 90])
  })
})
```

**Step 2: Rodar e confirmar falha**

```bash
cd app && npm run test -- tests/lib/df.test.ts
```

Expected: FAIL.

**Step 3: Implementar src/lib/df.ts**

```ts
// src/lib/df.ts
export function groupBy<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const r of rows) {
    const k = key(r)
    const bucket = out.get(k)
    if (bucket) bucket.push(r)
    else out.set(k, [r])
  }
  return out
}

export function sortBy<T, K extends string | number>(rows: T[], key: (r: T) => K): T[] {
  return rows.slice().sort((a, b) => {
    const ka = key(a), kb = key(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
}

export function leftJoin<L, R>(
  left: L[],
  right: R[],
  leftKey: (l: L) => string,
  rightKey: (r: R) => string,
): Array<L & Partial<R>> {
  const idx = new Map<string, R>()
  for (const r of right) idx.set(rightKey(r), r)
  return left.map(l => ({ ...l, ...(idx.get(leftKey(l)) ?? {}) }))
}

/** Equivalent to pandas: s.shift(1).rolling(window, min_periods=1).sum(). 
 *  Index 0 returns 0 (no prior data). Index i returns sum of values[max(0,i-window):i]. */
export function rollingSumPriorOnly(values: Array<number | null | undefined>, window: number): number[] {
  const out: number[] = new Array(values.length).fill(0)
  for (let i = 0; i < values.length; i++) {
    let s = 0
    for (let j = Math.max(0, i - window); j < i; j++) {
      const v = values[j]
      if (typeof v === 'number' && Number.isFinite(v)) s += v
    }
    out[i] = s
  }
  return out
}
```

**Step 4: PASS**

```bash
cd app && npm run test -- tests/lib/df.test.ts
```

Expected: PASS (4 tests).

**Step 5: Commit**

```bash
git add app/src/lib/df.ts app/tests/lib/df.test.ts
git commit -m "feat(df): add groupBy/sortBy/leftJoin/rollingSumPriorOnly helpers"
```

---

## Task 0.4: Gerar fixtures de paridade a partir do Python

**Files:**
- Create: `tools/generate_parity_fixtures.py`
- Create: `app/tests/fixtures/parity/` (gerado)

**Step 1: Escrever o gerador**

```python
# tools/generate_parity_fixtures.py
"""Generate parity fixtures: small Apice subset + expected outputs from each model.

Output dir: app/tests/fixtures/parity/
"""
from __future__ import annotations
import csv
import json
from pathlib import Path

import pandas as pd

from models.baseline_trend import build_baseline_trend_features
from models.anomaly_detection import add_robust_anomaly_flags
from models.confidence_score import add_confidence_score
from models.marginal_elasticity import build_campaign_elasticity_features
from models.saturation import add_saturation_features
from models.lever_diagnosis import add_lever_diagnosis
from models.campaign_scores import add_campaign_scores
from models.constraints_optimizer import apply_constraints
from models.projected_cos import add_projected_cos

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "app" / "tests" / "fixtures" / "parity"

def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    src = pd.read_csv(ROOT / "outputs" / "local_staging" / "apice_campaign_daily_enriched.csv")
    # take a stable subset: 5 campanhas com mais dias, últimos 60 dias
    top5 = (src.groupby("campaign_id").size().sort_values(ascending=False).head(5).index)
    sub = src[src["campaign_id"].isin(top5)].sort_values(["campaign_id", "date"]).copy()
    sub = sub.tail(60 * 5)  # 60 days * 5 campaigns
    sub.to_csv(OUT / "input_apice_daily.csv", index=False)

    # baseline
    bt = build_baseline_trend_features(sub)
    bt.to_csv(OUT / "expected_baseline_trend.csv", index=False)

    # anomaly
    an = add_robust_anomaly_flags(sub)
    an.to_csv(OUT / "expected_anomaly_detection.csv", index=False)

    # confidence
    co = add_confidence_score(bt)
    co.to_csv(OUT / "expected_confidence_score.csv", index=False)

    # elasticity
    el = build_campaign_elasticity_features(sub)
    el.to_csv(OUT / "expected_marginal_elasticity.csv", index=False)

    # saturation
    sat = add_saturation_features(bt)
    sat.to_csv(OUT / "expected_saturation.csv", index=False)

    # lever diagnosis
    lev = add_lever_diagnosis(co)
    lev.to_csv(OUT / "expected_lever_diagnosis.csv", index=False)

    # scores
    sc = add_campaign_scores(lev)
    sc.to_csv(OUT / "expected_campaign_scores.csv", index=False)

    # constraints
    cn = apply_constraints(sc)
    cn.to_csv(OUT / "expected_constraints_optimizer.csv", index=False)

    # projected cos
    pc = add_projected_cos(cn)
    pc.to_csv(OUT / "expected_projected_cos.csv", index=False)

    summary = {
        "input_rows": int(len(sub)),
        "campaigns": list(map(str, sorted(sub["campaign_id"].unique()))),
        "date_min": str(sub["date"].min()),
        "date_max": str(sub["date"].max()),
    }
    (OUT / "summary.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary, indent=2))

if __name__ == "__main__":
    main()
```

**Step 2: Rodar para gerar fixtures**

```bash
cd /home/pedrorocha/gotrends2 && python3 tools/generate_parity_fixtures.py
```

Expected: imprime summary com `input_rows` (~300), 5 campanhas, range de datas.

> **Nota:** se algum modelo Python falhar aqui (assinatura/coluna), corrigir o gerador, NÃO o modelo. Modelos Python são o ground truth.

**Step 3: Commit**

```bash
git add tools/generate_parity_fixtures.py app/tests/fixtures/parity/
git commit -m "test: generate parity fixtures from Python baseline (5 Apice campaigns, 60d)"
```

---

## Task 0.4b: Core types compartilhados

**Por que:** centraliza tipos do domínio para que `models/`, `db/`, `agent/`, `pipeline/` e `http/dto` falem a mesma linguagem.

**Files:**
- Create: `app/src/core/types.ts`
- Create: `app/src/core/constants.ts`
- Create: `app/src/core/errors.ts`

**Step 1:** Mover tipos previstos para `src/db/types.ts` na Task 1.2 (RecommendationRow, etc.) para `src/core/types.ts` — `db/types.ts` re-exporta + adiciona shape físico do row.

**Step 2:** Constants:

```ts
// src/core/constants.ts
export const PARITY_TOLERANCE = 1e-6
export const RECOMMENDATION_TTL_HOURS = 24
export const OUTCOME_WINDOWS = ['24h', '72h', '7d'] as const
export type OutcomeWindow = typeof OUTCOME_WINDOWS[number]
```

**Step 3:** Errors:

```ts
// src/core/errors.ts
export class GoTrendsError extends Error { constructor(public code: string, message: string) { super(message) } }
export class GuardrailBlocked extends GoTrendsError { constructor(reason: string) { super('GUARDRAIL_BLOCKED', reason) } }
export class ParityViolation extends GoTrendsError { constructor(field: string, actual: unknown, expected: unknown) { super('PARITY_VIOLATION', `${field}: ${actual} vs ${expected}`) } }
```

**Step 4: Commit**

```bash
git add app/src/core/
git commit -m "feat(core): centralize domain types, constants and tagged errors"
```

---

## Task 0.5: Parity harness genérico

**Files:**
- Create: `app/src/lib/csv.ts`
- Create: `app/tests/parity/harness.ts`
- Create: `app/tests/parity/harness.test.ts`

**Step 1: Escrever teste do harness**

```ts
// tests/parity/harness.test.ts
import { describe, it, expect } from 'vitest'
import { assertParity } from './harness'

describe('parity harness', () => {
  it('passes when float fields are within 1e-6', () => {
    expect(() =>
      assertParity(
        [{ id: '1', roas: 2.500001 }],
        [{ id: '1', roas: 2.5 }],
        { keyCols: ['id'], tolerance: 1e-5 },
      ),
    ).not.toThrow()
  })

  it('fails when float fields differ beyond tolerance', () => {
    expect(() =>
      assertParity(
        [{ id: '1', roas: 2.6 }],
        [{ id: '1', roas: 2.5 }],
        { keyCols: ['id'], tolerance: 1e-6 },
      ),
    ).toThrow(/roas/)
  })

  it('compares string fields exactly', () => {
    expect(() =>
      assertParity(
        [{ id: '1', status: 'positive' }],
        [{ id: '1', status: 'negative' }],
        { keyCols: ['id'] },
      ),
    ).toThrow(/status/)
  })
})
```

**Step 2: Implementar harness**

```ts
// src/lib/csv.ts
import { parse } from 'csv-parse/sync'
import { readFileSync } from 'node:fs'

export function readCsv<T = Record<string, string>>(path: string): T[] {
  const content = readFileSync(path, 'utf8')
  return parse(content, { columns: true, skip_empty_lines: true }) as T[]
}

export function coerceNumeric<T extends Record<string, unknown>>(rows: T[], cols: string[]): T[] {
  return rows.map(r => {
    const out: Record<string, unknown> = { ...r }
    for (const c of cols) {
      const v = r[c]
      if (v === '' || v === undefined || v === null) { out[c] = null; continue }
      const n = Number(v)
      out[c] = Number.isFinite(n) ? n : null
    }
    return out as T
  })
}
```

```ts
// tests/parity/harness.ts
type Opts = { keyCols: string[]; tolerance?: number; ignore?: string[] }

export function assertParity<A extends Record<string, unknown>, B extends Record<string, unknown>>(
  actual: A[],
  expected: B[],
  opts: Opts,
): void {
  const tol = opts.tolerance ?? 1e-6
  const ignore = new Set(opts.ignore ?? [])
  if (actual.length !== expected.length) {
    throw new Error(`row count mismatch: actual=${actual.length} expected=${expected.length}`)
  }
  const keyOf = (r: Record<string, unknown>) => opts.keyCols.map(k => String(r[k])).join('|')
  const idx = new Map(expected.map(r => [keyOf(r), r]))
  for (const a of actual) {
    const e = idx.get(keyOf(a))
    if (!e) throw new Error(`missing expected row for key=${keyOf(a)}`)
    for (const col of Object.keys(e)) {
      if (ignore.has(col)) continue
      const av = a[col], ev = e[col]
      if (typeof ev === 'number' && Number.isFinite(ev)) {
        const an = typeof av === 'number' ? av : Number(av)
        if (!Number.isFinite(an) || Math.abs(an - ev) > tol) {
          throw new Error(`float mismatch at ${keyOf(a)}.${col}: actual=${av} expected=${ev} tol=${tol}`)
        }
      } else if (ev === null || ev === '' || ev === undefined) {
        if (av !== null && av !== '' && av !== undefined && !(typeof av === 'number' && Number.isNaN(av))) {
          throw new Error(`null mismatch at ${keyOf(a)}.${col}: actual=${av} expected=null`)
        }
      } else {
        if (String(av) !== String(ev)) {
          throw new Error(`string mismatch at ${keyOf(a)}.${col}: actual=${av} expected=${ev}`)
        }
      }
    }
  }
}
```

**Step 3: Tests pass**

```bash
cd app && npm run test -- tests/parity/harness.test.ts
```

Expected: PASS.

**Step 4: Commit**

```bash
git add app/src/lib/csv.ts app/tests/parity/harness.ts app/tests/parity/harness.test.ts
git commit -m "test(parity): add float-tolerance harness with csv loader"
```

---

# FASE 1 — Schema SQLite + camada de DB

## Task 1.1: Schema multi-conta + bootstrap

**Files:**
- Create: `app/src/db/schema.ts`
- Create: `app/src/db/bootstrap.ts`
- Create: `app/tests/db/bootstrap.test.ts`

> **Nota:** o arquivo `app/src/schema.js` que já criei anteriormente fica como referência — vai ser substituído pelo `.ts` aqui.

**Step 1: Escrever schema.ts**

Copiar o conteúdo de `app/src/schema.js` (já criado em conversa anterior) e converter para TS exportando `SCHEMA_STATEMENTS`, `SEED_ACCOUNTS`, `SEED_SKILLS`. Adicionar tipagem:

```ts
// src/db/schema.ts
export const SCHEMA_STATEMENTS: string[] = [/* exato como em schema.js */]
export const SEED_ACCOUNTS = [/* ... */] as const
export const SEED_SKILLS = [/* ... */] as const
```

(O conteúdo SQL já foi escrito em `app/src/schema.js` durante a conversa — copiar literalmente.)

**Step 2: Escrever bootstrap.ts**

```ts
// src/db/bootstrap.ts
import { SCHEMA_STATEMENTS, SEED_ACCOUNTS, SEED_SKILLS } from './schema'

export interface GodeployDB {
  exec(sql: string, params?: unknown[]): Promise<{ rowsWritten: number }>
  query(sql: string, params?: unknown[]): Promise<{ columns: string[]; rows: unknown[][]; rowsRead: number }>
}

export async function bootstrapSchema(db: GodeployDB): Promise<void> {
  for (const stmt of SCHEMA_STATEMENTS) {
    await db.exec(stmt)
  }
}

export async function seedReferenceData(db: GodeployDB): Promise<void> {
  for (const a of SEED_ACCOUNTS) {
    await db.exec(
      `INSERT OR IGNORE INTO accounts (account_id, account_label, company, login_customer_id)
       VALUES (?, ?, ?, ?)`,
      [a.account_id, a.account_label, a.company, a.login_customer_id],
    )
  }
  for (const s of SEED_SKILLS) {
    await db.exec(
      `INSERT OR REPLACE INTO skills (skill_key, display_name, category, description, module_path)
       VALUES (?, ?, ?, ?, ?)`,
      [s.skill_key, s.display_name, s.category, s.description, s.module_path],
    )
  }
}
```

**Step 3: Mock de DB e teste**

```ts
// tests/db/bootstrap.test.ts
import { describe, it, expect } from 'vitest'
import { bootstrapSchema, seedReferenceData, type GodeployDB } from '@/db/bootstrap'

function fakeDb(): GodeployDB & { execs: string[]; rows: Map<string, unknown[][]> } {
  const execs: string[] = []
  const rows = new Map<string, unknown[][]>()
  return {
    execs, rows,
    async exec(sql) { execs.push(sql); return { rowsWritten: 1 } },
    async query() { return { columns: [], rows: [], rowsRead: 0 } },
  }
}

describe('bootstrap', () => {
  it('runs all schema statements without throwing', async () => {
    const db = fakeDb()
    await bootstrapSchema(db)
    expect(db.execs.length).toBeGreaterThan(10)
    expect(db.execs.some(s => /CREATE TABLE IF NOT EXISTS accounts/.test(s))).toBe(true)
    expect(db.execs.some(s => /CREATE VIEW agent_decision_log/.test(s))).toBe(true)
  })

  it('seeds Apice account and skill catalog', async () => {
    const db = fakeDb()
    await seedReferenceData(db)
    expect(db.execs.some(s => /INSERT OR IGNORE INTO accounts/.test(s))).toBe(true)
    expect(db.execs.filter(s => /INSERT OR REPLACE INTO skills/.test(s)).length).toBe(10)
  })
})
```

**Step 4: PASS + Commit**

```bash
cd app && npm test -- tests/db/bootstrap.test.ts
git add app/src/db/ app/tests/db/
git rm app/src/schema.js  # se ainda existir
git commit -m "feat(db): SQLite schema + bootstrap + seed (accounts, skills)"
```

---

## Task 1.2: Repositórios CRUD (recommendations, runs, approvals, executions, outcomes)

**Files:**
- Create: `app/src/db/repos/recommendations.ts`
- Create: `app/src/db/repos/runs.ts`
- Create: `app/src/db/repos/approvals.ts`
- Create: `app/src/db/repos/executions.ts`
- Create: `app/src/db/repos/outcomes.ts`
- Create: `app/src/db/repos/chat.ts`
- Create: `app/src/db/types.ts`
- Create: `app/tests/db/repos.test.ts`

**Step 1: Tipos**

```ts
// src/db/types.ts
export type RecommendationStatus =
  | 'pending' | 'sent_to_chat' | 'approved' | 'rejected'
  | 'expired' | 'executing' | 'executed' | 'failed'

export type GuardrailStatus = 'ok' | 'needs_human_review' | 'blocked'

export interface RecommendationRow {
  recommendation_id: string
  run_id: string
  account_id: string
  campaign_id: string
  campaign_name: string
  skill_type: string
  recommended_action: string
  change_percent: number | null
  current_budget_brl: number | null
  proposed_budget_brl: number | null
  current_target_roas: number | null
  proposed_target_roas: number | null
  expected_incremental_cost_brl: number | null
  expected_incremental_revenue_brl: number | null
  expected_marginal_roas: number | null
  projected_cos: number | null
  confidence_score: number | null
  risk_level: string | null
  reason: string | null
  guardrail_status: GuardrailStatus
  guardrail_reason: string | null
  llm_payload: string | null
  llm_explanation: string | null
  status: RecommendationStatus
  expires_at: string | null
  created_at: string
  updated_at: string
}

// ... approvals, executions, outcomes, runs, chat_messages (mirror schema)
```

**Step 2: Repos com a interface mínima**

```ts
// src/db/repos/recommendations.ts
import type { GodeployDB } from '../bootstrap'
import type { RecommendationRow, RecommendationStatus } from '../types'

export class RecommendationsRepo {
  constructor(private db: GodeployDB) {}

  async insert(rec: Omit<RecommendationRow, 'created_at' | 'updated_at'>): Promise<void> {
    await this.db.exec(
      `INSERT INTO recommendations (
        recommendation_id, run_id, account_id, campaign_id, campaign_name,
        skill_type, recommended_action, change_percent,
        current_budget_brl, proposed_budget_brl,
        current_target_roas, proposed_target_roas,
        expected_incremental_cost_brl, expected_incremental_revenue_brl,
        expected_marginal_roas, projected_cos,
        confidence_score, risk_level, reason,
        guardrail_status, guardrail_reason,
        llm_payload, llm_explanation, status, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rec.recommendation_id, rec.run_id, rec.account_id, rec.campaign_id, rec.campaign_name,
        rec.skill_type, rec.recommended_action, rec.change_percent,
        rec.current_budget_brl, rec.proposed_budget_brl,
        rec.current_target_roas, rec.proposed_target_roas,
        rec.expected_incremental_cost_brl, rec.expected_incremental_revenue_brl,
        rec.expected_marginal_roas, rec.projected_cos,
        rec.confidence_score, rec.risk_level, rec.reason,
        rec.guardrail_status, rec.guardrail_reason,
        rec.llm_payload, rec.llm_explanation, rec.status, rec.expires_at,
      ],
    )
  }

  async setStatus(id: string, status: RecommendationStatus): Promise<void> {
    await this.db.exec(
      `UPDATE recommendations SET status = ?, updated_at = datetime('now') WHERE recommendation_id = ?`,
      [status, id],
    )
  }

  async listByStatus(status: RecommendationStatus, limit = 100): Promise<RecommendationRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM recommendations WHERE status = ? ORDER BY created_at DESC LIMIT ?`,
      [status, limit],
    )
    return rows.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]])) as RecommendationRow)
  }

  async getById(id: string): Promise<RecommendationRow | null> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM recommendations WHERE recommendation_id = ? LIMIT 1`,
      [id],
    )
    if (rows.length === 0) return null
    return Object.fromEntries(columns.map((c, i) => [c, rows[0]![i]])) as RecommendationRow
  }
}
```

Repete o padrão para `RunsRepo`, `ApprovalsRepo`, `ExecutionsRepo`, `OutcomesRepo`, `ChatMessagesRepo`.

**Step 3: Teste de cada repo**

```ts
// tests/db/repos.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { RecommendationsRepo } from '@/db/repos/recommendations'

// fake DB with in-memory store
function memoryDb() {
  const store = new Map<string, any>()
  return {
    store,
    async exec(sql: string, params: any[] = []) {
      if (/INSERT INTO recommendations/.test(sql)) {
        store.set(params[0], {
          recommendation_id: params[0], run_id: params[1], account_id: params[2],
          /* ... mirror order ... */ status: params[23],
        })
      }
      if (/UPDATE recommendations SET status/.test(sql)) {
        const r = store.get(params[1]); if (r) r.status = params[0]
      }
      return { rowsWritten: 1 }
    },
    async query(sql: string, params: any[] = []) {
      if (/SELECT \* FROM recommendations WHERE recommendation_id/.test(sql)) {
        const r = store.get(params[0])
        if (!r) return { columns: [], rows: [], rowsRead: 0 }
        const cols = Object.keys(r); const vals = cols.map(c => r[c])
        return { columns: cols, rows: [vals], rowsRead: 1 }
      }
      return { columns: [], rows: [], rowsRead: 0 }
    },
  }
}

describe('RecommendationsRepo', () => {
  it('insert + getById round-trip', async () => {
    const db = memoryDb()
    const repo = new RecommendationsRepo(db as any)
    const rec = { recommendation_id: 'rec-1', run_id: 'r1', account_id: '77', campaign_id: 'c1', campaign_name: 'X', skill_type: 'budget_reallocation', recommended_action: 'increase_budget', change_percent: 0.1, current_budget_brl: 100, proposed_budget_brl: 110, current_target_roas: null, proposed_target_roas: null, expected_incremental_cost_brl: 10, expected_incremental_revenue_brl: 30, expected_marginal_roas: 3, projected_cos: 0.2, confidence_score: 80, risk_level: 'medium', reason: 'r', guardrail_status: 'ok' as const, guardrail_reason: null, llm_payload: null, llm_explanation: null, status: 'pending' as const, expires_at: null }
    await repo.insert(rec)
    const got = await repo.getById('rec-1')
    expect(got?.recommendation_id).toBe('rec-1')
    expect(got?.status).toBe('pending')
  })

  it('setStatus updates row', async () => {
    const db = memoryDb()
    const repo = new RecommendationsRepo(db as any)
    await repo.insert({ /* mesmo objeto acima */ recommendation_id: 'rec-2', status: 'pending' } as any)
    await repo.setStatus('rec-2', 'approved')
    const got = await repo.getById('rec-2')
    expect(got?.status).toBe('approved')
  })
})
```

**Step 4: PASS + Commit**

```bash
cd app && npm test -- tests/db/repos.test.ts
git add app/src/db/ app/tests/db/repos.test.ts
git commit -m "feat(db): add repos for recommendations/runs/approvals/executions/outcomes/chat"
```

---

# FASE 2 — Port dos modelos com paridade

> **Regra de ouro:** cada modelo só fecha task quando o teste de paridade contra o CSV gerado pelo Python passar com `1e-6`.

## Task 2.1: Port `baseline_trend`

**Files:**
- Create: `app/src/models/baselineTrend.ts`
- Create: `app/tests/parity/baselineTrend.parity.test.ts`

**Step 1: Escrever o teste de paridade primeiro**

```ts
// tests/parity/baselineTrend.parity.test.ts
import { describe, it } from 'vitest'
import { resolve } from 'node:path'
import { readCsv, coerceNumeric } from '@/lib/csv'
import { buildBaselineTrendFeatures } from '@/models/baselineTrend'
import { assertParity } from './harness'

const FIX = resolve(__dirname, '../fixtures/parity')

describe('parity: baseline_trend', () => {
  it('matches Python output within 1e-6', () => {
    const input = coerceNumeric(
      readCsv(`${FIX}/input_apice_daily.csv`),
      ['cost', 'conversion_value', 'impressions', 'clicks', 'conversions'],
    )
    const expected = coerceNumeric(
      readCsv(`${FIX}/expected_baseline_trend.csv`),
      ['cost', 'conversion_value', 'ctr', 'cpc', 'cvr', 'roas',
       'cost_7d', 'cost_14d', 'cost_28d', 'roas_7d', 'roas_14d', 'roas_28d',
       'conversion_value_7d', 'conversion_value_14d', 'conversion_value_28d',
       'clicks_28d', 'conversions_28d', 'same_weekday_roas', 'ewma_roas'],
    )
    const actual = buildBaselineTrendFeatures(input as any)
    assertParity(actual as any, expected as any, {
      keyCols: ['company', 'campaign_id', 'date'],
      tolerance: 1e-6,
    })
  })
})
```

**Step 2: Rodar e ver falhar (módulo inexistente)**

```bash
cd app && npm run test:parity -- baselineTrend
```

Expected: FAIL.

**Step 3: Implementar `src/models/baselineTrend.ts`**

```ts
// src/models/baselineTrend.ts
import { sortBy, groupBy, rollingSumPriorOnly } from '@/lib/df'
import { ewma } from '@/lib/stats'

const KEY = (r: { company: string; campaign_id: string }) => `${r.company}|${r.campaign_id}`

export interface BaselineConfig {
  ewmaAlpha: number
  strongPositive: number
  positive: number
  negative: number
  strongNegative: number
}
export const DEFAULT_BASELINE: BaselineConfig = {
  ewmaAlpha: 0.4, strongPositive: 1.35, positive: 1.20, negative: 0.80, strongNegative: 0.65,
}

function safeDiv(n: number | null, d: number | null): number | null {
  if (n === null || d === null || d === 0) return null
  return n / d
}

export function buildBaselineTrendFeatures<T extends {
  company: string; campaign_id: string; date: string;
  cost: number | null; conversion_value: number | null;
  impressions: number | null; clicks: number | null; conversions: number | null;
}>(rows: T[], config: BaselineConfig = DEFAULT_BASELINE) {
  // 1. add base ratios
  const enriched = rows.map(r => ({
    ...r,
    ctr: safeDiv(r.clicks, r.impressions),
    cpc: safeDiv(r.cost, r.clicks),
    cvr: safeDiv(r.conversions, r.clicks),
    roas: safeDiv(r.conversion_value, r.cost),
  }))

  // 2. sort and add rolling windows per group
  const out: any[] = []
  const groups = groupBy(enriched, KEY)
  for (const [, group] of groups) {
    const sorted = sortBy(group, r => r.date)
    const cost = sorted.map(r => r.cost)
    const conv = sorted.map(r => r.conversion_value)
    const clicks = sorted.map(r => r.clicks)
    const conversions = sorted.map(r => r.conversions)
    const cost7  = rollingSumPriorOnly(cost, 7),   conv7  = rollingSumPriorOnly(conv, 7)
    const cost14 = rollingSumPriorOnly(cost, 14),  conv14 = rollingSumPriorOnly(conv, 14)
    const cost28 = rollingSumPriorOnly(cost, 28),  conv28 = rollingSumPriorOnly(conv, 28)
    const clicks28 = rollingSumPriorOnly(clicks, 28)
    const conversions28 = rollingSumPriorOnly(conversions, 28)
    const ewmaRoas = ewma(sorted.map((r, i) => i === 0 ? null : sorted[i - 1]!.roas), config.ewmaAlpha)
    // same-weekday: collect per weekday subgroup
    const weekdayGroup = new Map<number, number[]>()
    sorted.forEach((r, i) => {
      const wd = new Date(r.date).getUTCDay() // pandas .dt.dayofweek: Monday=0…Sunday=6. JS getUTCDay: Sunday=0…Saturday=6 — adjust:
      const pyWd = (wd + 6) % 7
      const arr = weekdayGroup.get(pyWd) ?? []
      arr.push(i)
      weekdayGroup.set(pyWd, arr)
    })
    // for each row, same-weekday rolling sum on prior 8 same-weekday rows
    const sameRoas: Array<number | null> = sorted.map(() => null)
    for (const [, idxs] of weekdayGroup) {
      const costs = idxs.map(i => sorted[i]!.cost)
      const convs = idxs.map(i => sorted[i]!.conversion_value)
      const sumC = rollingSumPriorOnly(costs, 8)
      const sumV = rollingSumPriorOnly(convs, 8)
      idxs.forEach((rowIdx, k) => {
        sameRoas[rowIdx] = safeDiv(sumV[k]!, sumC[k]!)
      })
    }
    sorted.forEach((r, i) => {
      const roas28 = safeDiv(conv28[i]!, cost28[i]!)
      out.push({
        ...r,
        cost_7d: cost7[i], cost_14d: cost14[i], cost_28d: cost28[i],
        conversion_value_7d: conv7[i], conversion_value_14d: conv14[i], conversion_value_28d: conv28[i],
        roas_7d: safeDiv(conv7[i]!, cost7[i]!),
        roas_14d: safeDiv(conv14[i]!, cost14[i]!),
        roas_28d: roas28,
        clicks_28d: clicks28[i], conversions_28d: conversions28[i],
        weekday: (new Date(r.date).getUTCDay() + 6) % 7,
        same_weekday_roas: sameRoas[i],
        ewma_roas: ewmaRoas[i],
        trend_status: classifyTrend(r.roas, roas28, config),
      })
    })
  }
  return out
}

function classifyTrend(roas: number | null, roas28: number | null, c: BaselineConfig): string {
  if (roas === null || roas28 === null) return 'insufficient_data'
  if (roas > roas28 * c.strongPositive) return 'strong_positive'
  if (roas > roas28 * c.positive) return 'positive'
  if (roas < roas28 * c.strongNegative) return 'strong_negative'
  if (roas < roas28 * c.negative) return 'negative'
  return 'normal'
}
```

**Step 4: Rodar paridade**

```bash
cd app && npm run test:parity -- baselineTrend
```

Expected: PASS. Se falhar, comparar linha a linha o output TS contra `expected_baseline_trend.csv`, identificar coluna divergente, ajustar implementação. **NÃO** ajustar tolerância — corrigir o port.

**Step 5: Commit**

```bash
git add app/src/models/baselineTrend.ts app/tests/parity/baselineTrend.parity.test.ts
git commit -m "feat(models): port baseline_trend to TS, parity ✓ vs Python"
```

---

## Task 2.2 → 2.10: Port dos modelos restantes

**Padrão idêntico para cada um:** teste de paridade primeiro, implementação, PASS, commit.

| Task | Módulo Python | Arquivo TS | Notas |
|---|---|---|---|
| 2.2 | `models/anomaly_detection.py` | `src/models/anomalyDetection.ts` | Loop por linha com janela lookback. Robust z-score = `0.6745 * (v - median) / mad`. |
| 2.3 | `models/confidence_score.py` | `src/models/confidenceScore.ts` | Soma ponderada de capped components. |
| 2.4 | `models/marginal_elasticity.py` | `src/models/marginalElasticity.ts` | **Maior risco de divergência.** Usa `qcutRanks` + OLS + per-group merges. |
| 2.5 | `models/saturation.py` | `src/models/saturation.ts` | |
| 2.6 | `models/lever_diagnosis.py` | `src/models/leverDiagnosis.ts` | |
| 2.7 | `models/campaign_scores.py` | `src/models/campaignScores.ts` | |
| 2.8 | `models/constraints_optimizer.py` | `src/models/constraintsOptimizer.ts` | Lógica de guardrails. Saída controla `guardrail_status`. |
| 2.9 | `models/projected_cos.py` | `src/models/projectedCos.ts` | Curto, simples. |
| 2.10 | `models/backtesting.py` | `src/models/backtesting.ts` | Saída JSON; teste compara contra `expected_backtesting.json`. |

Em cada task:
1. Ler o Python correspondente em `/home/pedrorocha/gotrends2/models/<file>.py`
2. Identificar funções públicas e suas assinaturas
3. Escrever `tests/parity/<name>.parity.test.ts` carregando o CSV correspondente
4. Implementar em `src/models/<name>.ts`
5. Iterar até paridade `1e-6`
6. Commit

**Critério de fechamento da FASE 2:** `npm run test:parity` roda os 10 testes verdes.

---

## Task 2.10b: Skills registry + tools wrappers

**Por que:** os 10 modelos portados são apenas matemática. Para o agente usar, encapsulamos em **skills** (capabilities de negócio) e **tools** (ações atômicas). Ver `docs/ARCHITECTURE.md` para a distinção.

**Files:**
- Create: `app/src/agent/skills/registry.ts`
- Create: `app/src/agent/skills/{budgetReallocation,anomalyAlert,confidenceCheck,saturationCheck,cpaSpikeDiagnosis,guardrailsConstraints,projectedCos,roasForecast,weeklyDigest,decisionBacktest}.ts`
- Create: `app/src/agent/tools/{runModel,postToChat,executeBudgetChange,persistDecision}.ts`
- Create: `app/tests/agent/skills/registry.test.ts`

**Step 1: Registry**

```ts
// src/agent/skills/registry.ts
import type { GodeployDB } from '@/db/bootstrap'
import * as budgetReallocation from './budgetReallocation'
// ... outras

export type SkillCategory = 'diagnostic' | 'optimization' | 'reporting'
export interface SkillContext {
  db: GodeployDB
  /* clients injected later */
}
export interface SkillDescriptor {
  key: string
  displayName: string
  category: SkillCategory
  run(input: unknown, ctx: SkillContext): Promise<unknown>
}

export const SKILLS: SkillDescriptor[] = [
  budgetReallocation.descriptor,
  // ... outras
]

export function findSkill(key: string): SkillDescriptor | undefined {
  return SKILLS.find(s => s.key === key)
}
```

**Step 2: Cada skill exporta `descriptor` + função pura**

```ts
// src/agent/skills/budgetReallocation.ts
import type { SkillDescriptor, SkillContext } from './registry'
import { buildBaselineTrendFeatures } from '@/models/baselineTrend'
import { /* outros models */ } from '@/models'

export const descriptor: SkillDescriptor = {
  key: 'budget_reallocation',
  displayName: 'Budget Reallocation Model',
  category: 'optimization',
  run,
}

async function run(input: { dailyRows: any[] }, _ctx: SkillContext) {
  const bt = buildBaselineTrendFeatures(input.dailyRows)
  // ... encadeia modelos, retorna Recommendation[]
  return { recommendations: [/* ... */] }
}
```

**Step 3: Tools — ações reusáveis**

```ts
// src/agent/tools/runModel.ts
export async function runModel(name: string, rows: unknown[]) { /* dispatch */ }

// src/agent/tools/postToChat.ts
export async function postToChat(/* ... */) { /* usa GoogleChatClient */ }

// src/agent/tools/executeBudgetChange.ts
export async function executeBudgetChange(/* ... */) { /* usa GoogleAdsClient.mutateBudget */ }

// src/agent/tools/persistDecision.ts
export async function persistDecision(/* ... */) { /* usa RecommendationsRepo */ }
```

**Step 4: Teste do registry**

```ts
// tests/agent/skills/registry.test.ts
import { SKILLS, findSkill } from '@/agent/skills/registry'

it('lists 10 skills mapped to 3 categories', () => {
  expect(SKILLS.length).toBe(10)
  const cats = new Set(SKILLS.map(s => s.category))
  expect(cats).toEqual(new Set(['diagnostic', 'optimization', 'reporting']))
})
it('finds by key', () => {
  expect(findSkill('budget_reallocation')?.displayName).toMatch(/budget/i)
})
```

**Step 5: PASS + commit**

```bash
git add app/src/agent/ app/tests/agent/
git commit -m "feat(agent): skills registry + tools wrappers per ARCHITECTURE.md"
```

---

## Task 2.11: Port do `recommendation_agent` (camada explicativa)

**Files:**
- Create: `app/src/agent/recommendationAgent.ts`
- Create: `app/tests/agent/recommendationAgent.test.ts`

**Step 1: Teste**

```ts
// tests/agent/recommendationAgent.test.ts
import { describe, it, expect } from 'vitest'
import { buildLlmPayload, explainRecommendation } from '@/agent/recommendationAgent'

describe('recommendation agent', () => {
  it('explains a blocked recommendation', () => {
    const payload = buildLlmPayload({
      campaign_id: '1', campaign_name: 'Test',
      recommended_action: 'increase_budget',
      business_constraints_status: 'blocked',
      constraints_reason: 'manual_pause_active',
      approval_status: 'pending',
    })
    const out = explainRecommendation(payload)
    expect(out.headline).toMatch(/bloqueada/i)
    expect(out.do_not_execute_reason).toBe('manual_pause_active')
  })

  it('explains a normal recommendation', () => {
    const out = explainRecommendation(buildLlmPayload({
      campaign_id: '1', campaign_name: 'Test',
      recommended_action: 'increase_budget',
      business_constraints_status: 'needs_human_review',
      approval_status: 'pending',
      change_percent: 0.15, confidence_score: 80, risk_level: 'medium',
    }))
    expect(out.approval_note).toMatch(/aprova/i)
    expect(out.do_not_execute_reason).toBeNull()
  })
})
```

**Step 2:** Implementar mirror exato de `agent/recommendation_agent.py`.

**Step 3:** Tests PASS.

**Step 4:** Commit.

---

# FASE 3 — Clientes externos (Metabase, Google Ads, Google Chat)

## Task 3.1: Cliente Metabase

**Files:**
- Create: `app/src/clients/metabase.ts`
- Create: `app/tests/clients/metabase.test.ts`

**Step 1: Teste com fetch mockado**

```ts
import { describe, it, expect, vi } from 'vitest'
import { MetabaseClient } from '@/clients/metabase'

describe('MetabaseClient', () => {
  it('runs a SQL query via dataset endpoint', async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { cols: [{ name: 'x' }], rows: [[1]] } }),
    } as any)
    const c = new MetabaseClient({ url: 'https://m', apiKey: 'k', databaseId: 99 }, fetcher as any)
    const rows = await c.querySql('SELECT 1 AS x')
    expect(rows).toEqual([{ x: 1 }])
    expect(fetcher).toHaveBeenCalledWith(
      'https://m/api/dataset',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'k' }),
      }),
    )
  })
})
```

**Step 2: Implementação**

```ts
// src/clients/metabase.ts
export interface MetabaseConfig { url: string; apiKey: string; databaseId: number }
type Fetcher = typeof fetch

export class MetabaseClient {
  constructor(private cfg: MetabaseConfig, private fetcher: Fetcher = fetch) {}

  async querySql<T = Record<string, unknown>>(sql: string): Promise<T[]> {
    const res = await this.fetcher(`${this.cfg.url}/api/dataset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': this.cfg.apiKey },
      body: JSON.stringify({
        type: 'native',
        native: { query: sql },
        database: this.cfg.databaseId,
      }),
    })
    if (!res.ok) throw new Error(`Metabase ${res.status}: ${await res.text()}`)
    const json = await res.json() as any
    const cols = json.data.cols.map((c: any) => c.name)
    return json.data.rows.map((row: any[]) =>
      Object.fromEntries(cols.map((c: string, i: number) => [c, row[i]])))
  }
}
```

**Step 3: PASS + commit.**

---

## Task 3.2: Cliente Google Ads — OAuth2 + search + mutate

**Files:**
- Create: `app/src/clients/googleAds.ts`
- Create: `app/tests/clients/googleAds.test.ts`

**Step 1: Teste**

```ts
import { describe, it, expect, vi } from 'vitest'
import { GoogleAdsClient } from '@/clients/googleAds'

describe('GoogleAdsClient', () => {
  it('refreshes access token on first call', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) }) // token refresh
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ campaign: { id: '1' } }] }) }) // search
    const c = new GoogleAdsClient({
      developerToken: 'dev', clientId: 'cid', clientSecret: 'csec', refreshToken: 'rt',
      loginCustomerId: '7705857660',
    }, fetcher as any)
    const rows = await c.searchStream('7705857660', 'SELECT campaign.id FROM campaign LIMIT 1')
    expect(rows.length).toBe(1)
    const calls = fetcher.mock.calls
    expect(calls[0]![0]).toMatch(/oauth2\.googleapis\.com\/token/)
    expect(calls[1]![0]).toMatch(/googleads\.googleapis\.com.*\/customers\/7705857660\/googleAds:searchStream/)
  })

  it('mutateBudget POSTs operations array', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'AT', expires_in: 3600 }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ results: [{ resourceName: 'customers/77/campaignBudgets/123' }] }) })
    const c = new GoogleAdsClient({/* ... */} as any, fetcher as any)
    const out = await c.mutateBudget('7705857660', 'customers/7705857660/campaignBudgets/123', 250000000)
    expect(out.resourceName).toMatch(/campaignBudgets/)
    const body = JSON.parse(fetcher.mock.calls[1]![1].body as string)
    expect(body.operations[0].update.amountMicros).toBe(250000000)
  })
})
```

**Step 2: Implementação**

```ts
// src/clients/googleAds.ts
export interface GoogleAdsConfig {
  developerToken: string
  clientId: string
  clientSecret: string
  refreshToken: string
  loginCustomerId: string
  apiVersion?: string  // default v18
}
type Fetcher = typeof fetch

export class GoogleAdsClient {
  private accessToken: string | null = null
  private tokenExpiresAt = 0
  constructor(private cfg: GoogleAdsConfig, private fetcher: Fetcher = fetch) {}

  private get version() { return this.cfg.apiVersion ?? 'v18' }

  private async ensureToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken
    const res = await this.fetcher('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        refresh_token: this.cfg.refreshToken,
        grant_type: 'refresh_token',
      }),
    })
    if (!res.ok) throw new Error(`google oauth ${res.status}: ${await res.text()}`)
    const j = await res.json() as any
    this.accessToken = j.access_token
    this.tokenExpiresAt = Date.now() + j.expires_in * 1000
    return this.accessToken!
  }

  private headers(token: string): HeadersInit {
    return {
      authorization: `Bearer ${token}`,
      'developer-token': this.cfg.developerToken,
      'login-customer-id': this.cfg.loginCustomerId,
      'content-type': 'application/json',
    }
  }

  async searchStream(customerId: string, gaql: string): Promise<any[]> {
    const tok = await this.ensureToken()
    const res = await this.fetcher(
      `https://googleads.googleapis.com/${this.version}/customers/${customerId}/googleAds:searchStream`,
      { method: 'POST', headers: this.headers(tok), body: JSON.stringify({ query: gaql }) },
    )
    if (!res.ok) throw new Error(`googleAds ${res.status}: ${await res.text()}`)
    const json = await res.json() as any
    // searchStream returns an array of result chunks; results are flattened
    if (Array.isArray(json)) return json.flatMap(c => c.results ?? [])
    return json.results ?? []
  }

  async mutateBudget(customerId: string, budgetResource: string, amountMicros: number): Promise<{ resourceName: string }> {
    const tok = await this.ensureToken()
    const res = await this.fetcher(
      `https://googleads.googleapis.com/${this.version}/customers/${customerId}/campaignBudgets:mutate`,
      {
        method: 'POST', headers: this.headers(tok),
        body: JSON.stringify({
          operations: [{
            update: { resourceName: budgetResource, amountMicros: String(amountMicros) },
            updateMask: 'amountMicros',
          }],
        }),
      },
    )
    if (!res.ok) throw new Error(`googleAds mutate ${res.status}: ${await res.text()}`)
    const j = await res.json() as any
    return j.results[0]
  }

  async mutateCampaignTargetRoas(customerId: string, campaignResource: string, targetRoas: number) {
    const tok = await this.ensureToken()
    const res = await this.fetcher(
      `https://googleads.googleapis.com/${this.version}/customers/${customerId}/campaigns:mutate`,
      {
        method: 'POST', headers: this.headers(tok),
        body: JSON.stringify({
          operations: [{
            update: { resourceName: campaignResource, maximizeConversionValue: { targetRoas } },
            updateMask: 'maximizeConversionValue.targetRoas',
          }],
        }),
      },
    )
    if (!res.ok) throw new Error(`googleAds mutate roas ${res.status}: ${await res.text()}`)
    return ((await res.json()) as any).results[0]
  }
}
```

**Step 3: PASS + commit.**

---

## Task 3.3: Cliente Google Chat (envio de card + verificação de webhook)

**Files:**
- Create: `app/src/clients/googleChat.ts`
- Create: `app/tests/clients/googleChat.test.ts`

**Step 1: Teste**

```ts
import { describe, it, expect, vi } from 'vitest'
import { GoogleChatClient, buildRecommendationCard } from '@/clients/googleChat'

describe('GoogleChat', () => {
  it('builds a Card v2 with approve/reject buttons', () => {
    const card = buildRecommendationCard({
      recommendationId: 'rec-1',
      headline: 'Aumentar budget em Search NB',
      campaign: 'Search NB',
      changePercent: 0.15,
      expectedRevenue: 1850,
      expectedCost: 620,
      marginalRoas: 2.98,
      confidence: 78,
      risk: 'medium',
    })
    const json = JSON.stringify(card)
    expect(json).toContain('rec-1')
    expect(json).toContain('Aprovar')
    expect(json).toContain('Rejeitar')
  })

  it('posts to webhook URL', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ name: 'spaces/X/messages/Y' }) } as any)
    const c = new GoogleChatClient(fetcher as any)
    const msg = await c.postCard('https://chat.googleapis.com/v1/spaces/X/messages?key=K&token=T', {} as any)
    expect(msg.name).toBe('spaces/X/messages/Y')
  })
})
```

**Step 2: Implementação**

```ts
// src/clients/googleChat.ts
type Fetcher = typeof fetch

export interface RecommendationCardInput {
  recommendationId: string
  headline: string
  campaign: string
  changePercent: number | null
  expectedRevenue: number | null
  expectedCost: number | null
  marginalRoas: number | null
  confidence: number | null
  risk: string | null
}

export function buildRecommendationCard(i: RecommendationCardInput) {
  const fmtPct = (v: number | null) => v === null ? '—' : `${(v * 100).toFixed(1)}%`.replace('.', ',')
  const fmtMoney = (v: number | null) => v === null ? '—' : `R$ ${v.toFixed(2)}`
  return {
    cardsV2: [{
      cardId: i.recommendationId,
      card: {
        header: { title: i.headline, subtitle: i.campaign },
        sections: [{
          widgets: [
            { decoratedText: { topLabel: 'Mudança proposta', text: fmtPct(i.changePercent) } },
            { decoratedText: { topLabel: 'Receita incremental esperada', text: fmtMoney(i.expectedRevenue) } },
            { decoratedText: { topLabel: 'Custo incremental esperado', text: fmtMoney(i.expectedCost) } },
            { decoratedText: { topLabel: 'ROAS marginal', text: i.marginalRoas?.toFixed(2) ?? '—' } },
            { decoratedText: { topLabel: 'Confiança', text: `${i.confidence ?? '—'}` } },
            { decoratedText: { topLabel: 'Risco', text: i.risk ?? '—' } },
            { buttonList: { buttons: [
              { text: 'Aprovar', onClick: { action: { function: 'approve', parameters: [{ key: 'rec', value: i.recommendationId }] } }, color: { red: 0.1, green: 0.6, blue: 0.2 } },
              { text: 'Rejeitar', onClick: { action: { function: 'reject', parameters: [{ key: 'rec', value: i.recommendationId }] } }, color: { red: 0.7, green: 0.1, blue: 0.1 } },
            ] } },
          ],
        }],
      },
    }],
  }
}

export class GoogleChatClient {
  constructor(private fetcher: Fetcher = fetch) {}
  async postCard(webhookUrl: string, body: ReturnType<typeof buildRecommendationCard>): Promise<{ name: string }> {
    const res = await this.fetcher(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`googleChat ${res.status}: ${await res.text()}`)
    return await res.json() as { name: string }
  }
}
```

**Step 3: PASS + commit.**

---

# FASE 4 — Pipeline orquestrador

## Task 4.1: Orquestrador `runModelsForAccount`

**Files:**
- Create: `app/src/pipeline/runModels.ts`
- Create: `app/tests/pipeline/runModels.test.ts`

Orquestra a sequência: fetch daily/hourly do Metabase → enrich com settings do Google Ads → roda os 10 modelos → persiste features → produz e persiste `recommendations` com `status='pending'`.

**Step 1: Teste de integração com mocks**

```ts
// tests/pipeline/runModels.test.ts
import { describe, it, expect } from 'vitest'
import { runModelsForAccount } from '@/pipeline/runModels'

describe('runModelsForAccount', () => {
  it('persists run + recommendations from fixtures', async () => {
    /* setup fake DB, fake Metabase, fake Google Ads.
       assert: 1 row in model_runs, N rows in recommendations.
       (Detalhar quando implementar.) */
  })
})
```

**Step 2: Implementação esqueleto (preencher conforme modelos ficam prontos)**

```ts
// src/pipeline/runModels.ts
import { v4 as uuid } from '../lib/uuid'  // ver Task 0.6 abaixo
import type { GodeployDB } from '@/db/bootstrap'
import { RunsRepo } from '@/db/repos/runs'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import type { MetabaseClient } from '@/clients/metabase'
import type { GoogleAdsClient } from '@/clients/googleAds'
import { buildBaselineTrendFeatures } from '@/models/baselineTrend'
// import others as they land

export interface RunOptions { accountId: string; pipelineVersion: string }

export async function runModelsForAccount(
  db: GodeployDB,
  metabase: MetabaseClient,
  googleAds: GoogleAdsClient,
  opts: RunOptions,
): Promise<{ runId: string; nRecommendations: number }> {
  const runs = new RunsRepo(db); const recs = new RecommendationsRepo(db)
  const runId = uuid()
  await runs.insert({ run_id: runId, account_id: opts.accountId, pipeline_version: opts.pipelineVersion, status: 'running', n_campaigns_scanned: null, n_recommendations: null, input_window_start: null, input_window_end: null, notes: null })

  // 1. fetch daily from Metabase
  // 2. fetch settings from Google Ads
  // 3. enrich daily with budget/target_roas/target_cpa
  // 4. run baseline → anomaly → confidence → elasticity → saturation → lever → scores → constraints → projected_cos
  // 5. build recommendation rows
  // 6. recs.insert(...) for each
  // 7. runs.update finalize

  return { runId, nRecommendations: 0 }
}
```

**Step 3: PASS (com TODO marcadores) + commit.**

**Step 4 (após FASE 2 inteira pronta):** preencher as etapas 1-7 e expandir o teste para asserts reais.

---

## Task 4.2: Geração de UUID v4 leve (sem dep)

**Files:**
- Create: `app/src/lib/uuid.ts`
- Create: `app/tests/lib/uuid.test.ts`

Use `crypto.randomUUID()` (disponível em CF Workers). Teste apenas valida formato.

---

# FASE 5 — Worker HTTP (API + webhook + UI shell)

## Task 5.1: Router Hono com bootstrap automático

**Files:**
- Create: `app/src/index.ts`
- Create: `app/tests/api/health.test.ts`

**Step 1: Teste de smoke**

```ts
import { describe, it, expect } from 'vitest'
import worker from '@/index'

describe('GET /api/health', () => {
  it('returns { ok: true } after bootstrap', async () => {
    const env = makeFakeEnv()
    const res = await worker.fetch(new Request('http://x/api/health'), env, {} as any)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})
```

**Step 2: Implementação**

```ts
// src/index.ts
import { Hono } from 'hono'
import { bootstrapSchema, seedReferenceData, type GodeployDB } from './db/bootstrap'
import { mountApi } from './http/api'

export interface Env { DB: GodeployDB; GOOGLE_ADS_DEVELOPER_TOKEN?: string; /* ... */ }

let bootstrapped = false
async function ensureBootstrap(env: Env) {
  if (bootstrapped) return
  await bootstrapSchema(env.DB)
  await seedReferenceData(env.DB)
  bootstrapped = true
}

const app = new Hono<{ Bindings: Env }>()
app.use('*', async (c, next) => { await ensureBootstrap(c.env); await next() })
app.get('/api/health', c => c.json({ ok: true }))
mountApi(app)

export default { fetch: app.fetch }
```

**Step 3:** PASS + commit.

---

## Task 5.1b: Estrutura `http/routes/` e `http/dto/`

**Files:**
- Create: `app/src/http/middleware.ts`
- Create: `app/src/http/dto/{recommendation,run,approval}.ts`
- Create: `app/src/http/routes/{health,runs,recommendations,skills,decisionLog,ingest,chatWebhook,execute,cron}.ts`
- Modify: `app/src/http/index.ts` para apenas montar rotas

**Step 1: Middleware**

```ts
// src/http/middleware.ts
import type { MiddlewareHandler } from 'hono'
import type { Env } from '@/index'

export const requireIngestToken: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const tok = c.req.header('x-ingest-token')
  if (tok !== c.env.INGEST_TOKEN) return c.json({ error: 'unauthorized' }, 401)
  await next()
}

export const requireCronKey: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const k = c.req.header('x-godeploy-cron')
  if (!k || k !== c.env.GODEPLOY_CRON_KEY) return c.json({ error: 'forbidden' }, 403)
  await next()
}
```

**Step 2: DTOs** — shapes que cruzam HTTP, separados do row do DB.

```ts
// src/http/dto/recommendation.ts
export interface RecommendationDTO {
  id: string
  account: { id: string; label: string }
  campaign: { id: string; name: string }
  skill: string
  action: string
  changePercent: number | null
  expected: { incrementalCost: number | null; incrementalRevenue: number | null; marginalRoas: number | null }
  confidence: number | null
  risk: string | null
  guardrail: { status: string; reason: string | null }
  status: string
  createdAt: string
}

export function toDTO(row: import('@/db/types').RecommendationRow): RecommendationDTO {
  return { /* mapping */ } as RecommendationDTO
}
```

**Step 3: Routes** — cada arquivo registra suas rotas no router pai.

```ts
// src/http/routes/recommendations.ts
import { Hono } from 'hono'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import { toDTO } from '@/http/dto/recommendation'
import type { Env } from '@/index'

export const recsRouter = new Hono<{ Bindings: Env }>()
recsRouter.get('/', async c => {
  const status = c.req.query('status')
  const repo = new RecommendationsRepo(c.env.DB)
  const rows = status ? await repo.listByStatus(status as any) : await repo.listRecent(100)
  return c.json(rows.map(toDTO))
})
recsRouter.get('/:id', async c => {
  const repo = new RecommendationsRepo(c.env.DB)
  const row = await repo.getById(c.req.param('id'))
  return row ? c.json(toDTO(row)) : c.json({ error: 'not_found' }, 404)
})
```

**Step 4: index.ts monta tudo**

```ts
// src/http/index.ts
import { Hono } from 'hono'
import { recsRouter } from './routes/recommendations'
// ... outros
import type { Env } from '@/index'

export function mountApi(app: Hono<{ Bindings: Env }>) {
  app.route('/api/recommendations', recsRouter)
  // ... outros app.route()
}
```

**Step 5:** testes mínimos por rota + commit.

---

## Task 5.2: Rotas API (listagem + detalhe + ingest)

**Files:**
- Create: `app/src/http/api.ts`
- Create: `app/tests/api/recommendations.test.ts`

Endpoints:
- `GET  /api/runs` — lista runs com filtro `account_id`
- `GET  /api/recommendations` — filtros: `status`, `account_id`, `campaign_id`, `skill_type`, `risk_level`, `q`
- `GET  /api/recommendations/:id` — detalhe completo + approvals + executions + outcomes
- `POST /api/ingest/run` — recebe um run inteiro do pipeline (idempotente por `run_id`)
- `GET  /api/skills` — catálogo
- `GET  /api/decision-log` — agent_decision_log (view) com filtros

Cada endpoint tem teste com fake DB.

---

## Task 5.3: Webhook Google Chat

**Files:**
- Create: `app/src/http/chatWebhook.ts`
- Create: `app/tests/api/chatWebhook.test.ts`

Recebe POST do Google Chat quando alguém clica no botão. Extrai:
- `user.email`, `user.displayName`, `user.name`
- `action.parameters[].value` → `recommendation_id`
- `action.function` → `'approve'` ou `'reject'`

Persiste em `approvals` e atualiza `recommendations.status`. **Não verifica se o aprovador é "autorizado"** — qualquer membro do espaço pode aprovar (decisão do produto). Salva email para auditoria.

Verifica `Authorization: Bearer <token>` ou JWT do Google (verificação assinatura issuer Google) — em V1, valida pelo secret compartilhado `GOOGLE_CHAT_VERIFICATION_TOKEN`.

---

## Task 5.4: Executor `/api/execute/:id`

**Files:**
- Create: `app/src/http/execute.ts`
- Create: `app/tests/api/execute.test.ts`

Fluxo:
1. Carrega `recommendation` por id
2. Valida `status === 'approved'` e `guardrail_status !== 'blocked'`
3. Cria linha em `executions` com `status='running'`
4. Chama `googleAds.mutateBudget(...)` (ou `mutateCampaignTargetRoas`) baseado em `recommended_action`
5. Atualiza `executions` para `success`/`error` com payload da API
6. Atualiza `recommendations.status` para `executed`/`failed`

**Idempotência:** se já existir execution `success` para esse `recommendation_id`, retorna 409. Reexecuções incrementam `attempt_number`.

---

# FASE 6 — Frontend SPA

## Task 6.1: Setup Vite + React + Tailwind

**Files:**
- Create: `app/client/main.tsx`
- Create: `app/client/App.tsx`
- Create: `app/client/index.css`
- Create: `app/index.html`
- Create: `app/vite.config.ts`
- Modify: `app/package.json` (adicionar build script)

Setup mínimo. Build target = ES2022. Output em `dist/` que será passado como `client` no `createApp`.

---

## Task 6.2: Páginas da SPA

**Files:** `app/client/pages/*.tsx`

| Página | Rota | Descrição |
|---|---|---|
| `Dashboard` | `/` | Cards: nº pendentes, aprovados hoje, executados, falhas, ROAS realizado vs esperado |
| `Recommendations` | `/recommendations` | Tabela filtrável (status, account, skill, risk) com link pra detalhe |
| `RecommendationDetail` | `/recommendations/:id` | Header com headline LLM + tabs (Payload, Histórico Chat, Execução, Outcome 24h/72h) |
| `Runs` | `/runs` | Lista de execuções diárias do pipeline com contagens |
| `Campaign` | `/campaigns/:accountId/:campaignId` | Série histórica + todas as recommendations dessa campanha |
| `Skills` | `/skills` | Catálogo inspirado no Ryze: 3 colunas (Diagnostic/Optimization/Reporting) com cards |
| `Digest` | `/digest` | Weekly digest renderizado (gera markdown) |

Cada página tem 1 teste de componente (Vitest + React Testing Library opcional, ou só smoke de render).

---

## Task 6.3: Estado/data fetching

**Files:** `app/client/api.ts`, `app/client/hooks/*`

Sem libs grandes. `fetch` direto + `useState`/`useEffect`. Se ficar repetitivo, considerar `swr` (mas tentar evitar dep).

---

# FASE 7 — Deploy Godeploy + cron

## Task 7.1: First deploy (worker + assets)

**Files:**
- Modify: `app/vite.config.ts` (output em `app/dist/client`)
- Create: `app/build.sh` (helper)

**Step 1: Build local**

```bash
cd app && npm run typecheck && npm run test && npm run build:client
```

Expected: PASS em tudo, `dist/client/index.html` gerado.

**Step 2: Empacotar upload — listar arquivos**

Arquivos a subir no upload:
- `src/**/*.ts`
- `dist/client/**/*` (HTML/CSS/JS bundled)
- `package.json`, `package-lock.json`
- `tsconfig.json`

**Step 3: `getUploadToken` via MCP**

(Executado pelo Claude na sessão de deploy.)

**Step 4: POST multipart files** para o `uploadUrl` retornado.

**Step 5: `createApp`**

```text
name: gotrends-agent
description: "GoTrends v2 agentic platform — multi-account Google Ads decision loop"
entrypoint: src/index.ts
client: [client/main.tsx]
assets: ["dist/client/index.html"]
```

**Step 6: Setar secrets**

```text
setAppSecret GOOGLE_ADS_DEVELOPER_TOKEN   <…>
setAppSecret GOOGLE_ADS_CLIENT_ID         <…>
setAppSecret GOOGLE_ADS_CLIENT_SECRET     <…>
setAppSecret GOOGLE_ADS_REFRESH_TOKEN     <…>
setAppSecret GOOGLE_ADS_LOGIN_CUSTOMER_ID 7705857660
setAppSecret METABASE_URL                 <…>
setAppSecret METABASE_API_KEY             <…>
setAppSecret METABASE_DATABASE_ID         <…>
setAppSecret GOOGLE_CHAT_WEBHOOK_URL      <…>
setAppSecret GOOGLE_CHAT_VERIFICATION_TOKEN <…>
setAppSecret INGEST_TOKEN                 <gerar e guardar>
```

**Step 7: Setar slug**

```text
setAppSlug → gotrends-agent
```

**Step 8: Smoke test**

```bash
curl https://gotrends-agent.<godeploy-domain>/api/health
```

Expected: `{ "ok": true }`.

```bash
curl https://gotrends-agent.<godeploy-domain>/api/skills
```

Expected: 10 skills do seed.

**Step 9: Commit do build artifact (sem subir dist no git)**

```bash
git add app/build.sh app/vite.config.ts
git commit -m "chore: first Godeploy deploy of gotrends-agent (worker + SPA)"
```

---

## Task 7.2: Cron jobs

**Files:** nenhum no repo — chamadas MCP

```text
createCronJob run-models-daily     "0 6 * * *"  /cron/run-models
createCronJob send-to-chat         "*/15 * * * *"  /cron/send-to-chat
createCronJob outcomes-24h         "0 7 * * *"  /cron/outcomes/24h
createCronJob outcomes-72h         "0 8 * * *"  /cron/outcomes/72h
```

Cada rota POST verifica `X-Godeploy-Cron` contra `env.GODEPLOY_CRON_KEY`.

---

# FASE 8 — Validação do loop fechado end-to-end

## Task 8.1: Smoke test manual com 1 recomendação real

1. Deploy ok
2. Acionar manualmente `/cron/run-models` com header válido
3. Verificar `GET /api/recommendations?status=pending` retorna ≥1 linha
4. Acionar `/cron/send-to-chat`
5. Card aparece no espaço Google Chat
6. Aprovar via botão
7. Verificar `/api/recommendations/:id` mostra `status=approved` + `approval` registrada
8. Verificar `executions` populado com `status=success` e `before/after_budget_brl`
9. Aguardar cron `outcomes-24h` (ou disparar manualmente com janela curta) → `execution_outcomes` populado

**Critério de fechamento:** loop completo no log da app + na UI de auditoria.

---

## Task 8.2: Aposentar Python (apenas após paridade 100%)

**Files:**
- Move: `models/` → `legacy/python/models/`
- Move: `tools/run_apice_local_models.py` → `legacy/python/tools/`
- Update: `README.md` apontando para `app/`

Manter `tools/generate_parity_fixtures.py` ativo — vira teste de regressão se um dia mexerem nos modelos.

---

# Marcos / critérios de pronto

| Fase | Critério |
|---|---|
| 0 | `npm test` verde, fixtures geradas no repo |
| 1 | Schema + 6 repos com testes verdes |
| 2 | 10 testes de paridade verdes com `1e-6` |
| 3 | 3 clientes com testes mockados verdes |
| 4 | Orquestrador roda contra fixtures e popula DB fake |
| 5 | API + Webhook + Executor com testes verdes |
| 6 | SPA buildável, 7 páginas, smoke tests |
| 7 | App deployada no Godeploy, `/api/health` responde, 4 crons criados |
| 8 | 1 recomendação real percorre o loop completo |

---

# Anti-objetivos (NÃO fazer nesse plano)

- ❌ Não adicionar nova skill que não exista hoje em Python (Wasted Spend Audit, Negative Keyword Mining etc.) — fica pra plano separado depois da paridade
- ❌ Não trocar SQLite por Postgres "por garantia" — Godeploy SQLite suporta o caso, ver `docs/plans/2026-06-10-godeploy-platform-migration.md` seção "Limites reais"
- ❌ Não otimizar pipeline para escala que não temos (datasets de milhões de linhas) — YAGNI
- ❌ Não implementar auth/permissões granulares na FASE 1 — aprovador = qualquer membro do espaço Chat (decisão do produto)
- ❌ Não tentar usar Next.js — Godeploy não suporta Next.js puro; SPA + Worker é o caminho

---

# Recursos relevantes

- Modelos Python originais: `/home/pedrorocha/gotrends2/models/`
- Master prompt do projeto: `/home/pedrorocha/gotrends2/GOTRENDS_V2_MASTER_PROMPT.md`
- Documentação por modelo: `/home/pedrorocha/gotrends2/docs/{BASELINE_TREND,CONFIDENCE_SCORE,...}.md`
- Inspiração taxonomia skills: https://www.get-ryze.ai/blog/claude-skills-for-google-ads
- Google Ads API REST: https://developers.google.com/google-ads/api/rest/overview
- Google Chat API: https://developers.google.com/workspace/chat
- Cloudflare Workers limits: https://developers.cloudflare.com/workers/platform/limits/
