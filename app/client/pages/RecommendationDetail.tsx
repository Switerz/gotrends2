import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useRecommendation } from '~/hooks/useRecommendation'
import { Card, CardBody, CardHeader } from '~/components/ui/Card'
import { Badge, biddingLearningTone, guardrailTone, riskTone, statusTone } from '~/components/ui/Badge'
import { Tabs } from '~/components/ui/Tabs'
import { Spinner } from '~/components/ui/Spinner'
import { fmtBrl, fmtNumber, fmtPct, fmtRelative } from '~/lib/formatters'
import { actionLabel } from '~/lib/actionLabels'

type AutoActionStatus = 'idle' | 'running' | 'success' | 'error'

function LabeledValue({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
        {label}
      </div>
      <div className="font-mono tabular-nums text-ink-100 text-sm">{value}</div>
    </div>
  )
}

function DriftBar({
  label,
  consumed,
  proposed,
  cap,
}: {
  label: string
  consumed: number
  proposed: number
  cap: number
}) {
  // Two-segment horizontal bar: historical consumed (sage/amber) + this rec's
  // contribution (cobalt). Anything past the cap renders in coral.
  const total = consumed + proposed
  const consumedPct = Math.min(100, (consumed / cap) * 100)
  const proposedPct = Math.min(100, Math.max(0, (proposed / cap) * 100))
  const overflowPct = Math.max(0, ((total - cap) / cap) * 100)
  const tone =
    total > cap
      ? 'text-coral'
      : total / cap > 0.7
        ? 'text-amber'
        : 'text-ink-300'
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1">
        <span className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400">
          {label}
        </span>
        <span className={`font-mono tabular-nums text-xs ${tone}`}>
          {(total * 100).toFixed(0)}% / {(cap * 100).toFixed(0)}%
        </span>
      </div>
      <div className="flex h-[6px] rounded-full bg-ink-700 overflow-hidden">
        <div className="bg-sage/70" style={{ width: `${consumedPct}%` }} />
        <div className="bg-cobalt/80" style={{ width: `${proposedPct}%` }} />
        {overflowPct > 0 && (
          <div
            className="bg-coral"
            style={{ width: `${Math.min(100, overflowPct)}%` }}
          />
        )}
      </div>
    </div>
  )
}

function ConfidenceBlock({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return <div className="font-mono text-ink-300 tabular-nums">—</div>
  }
  const pct = Math.max(0, Math.min(1, value))
  const tone = pct >= 0.6 ? 'bg-sage' : pct >= 0.4 ? 'bg-amber' : 'bg-coral'
  return (
    <div>
      <div className="font-mono tabular-nums text-ink-100 text-sm mb-2">{fmtPct(pct, 0)}</div>
      <div className="h-[5px] bg-ink-700 rounded-full overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${(pct * 100).toFixed(0)}%` }} />
      </div>
    </div>
  )
}

export default function RecommendationDetail() {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const rawAction = searchParams.get('action')
  const action: 'approve' | 'reject' | null =
    rawAction === 'approve' || rawAction === 'reject' ? rawAction : null

  // Auto-action flow runs only when ?action=approve|reject is present on the URL.
  // This is how the Google Chat openLink buttons land us here: the SPA posts to
  // /api/recommendations/:id/(approve|reject) using the session cookie, then
  // attempts to close the tab. Browsers may block window.close() for tabs that
  // weren't opened by JS — in that case the success view stays visible with a
  // "you can close this tab" hint.
  const [autoActionStatus, setAutoActionStatus] = useState<AutoActionStatus>(
    action ? 'running' : 'idle',
  )
  const [autoActionError, setAutoActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!action || !id) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(`/api/recommendations/${id}/${action}`, {
          method: 'POST',
          headers: { accept: 'application/json' },
          credentials: 'include',
        })
        if (cancelled) return
        if (res.status === 401) {
          // Not logged in — bounce through Google OAuth, preserving the action
          // URL so the effect re-runs after the redirect lands us back here.
          const next = window.location.pathname + window.location.search
          window.location.href = `/api/auth/login?next=${encodeURIComponent(next)}`
          return
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          throw new Error(`${res.status}: ${text.slice(0, 200)}`)
        }
        setAutoActionStatus('success')
        // Brief success view, then attempt to close the tab.
        setTimeout(() => {
          if (cancelled) return
          window.close()
        }, 1200)
      } catch (e) {
        if (cancelled) return
        setAutoActionStatus('error')
        setAutoActionError((e as Error).message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [action, id])

  // When ?action= is present, render a focused full-page pane instead of the
  // normal detail view — the user came here to confirm a decision, not browse.
  if (action) {
    return (
      <AutoActionPane
        action={action}
        status={autoActionStatus}
        error={autoActionError}
      />
    )
  }

  return <RecommendationDetailView id={id} />
}

function RecommendationDetailView({ id }: { id: string | undefined }) {
  const { data: rec, error, isLoading } = useRecommendation(id)

  if (isLoading) {
    return (
      <div className="py-16 flex justify-center">
        <Spinner size={24} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="py-10">
        <div className="hairline rounded-card bg-coral-wash/40 px-5 py-4 text-sm text-coral">
          Falha ao carregar recomendação: {String(error.message ?? error)}
        </div>
      </div>
    )
  }

  if (!rec) {
    return (
      <div className="py-10 text-ink-300">Recomendação não encontrada.</div>
    )
  }

  const explanation =
    rec.llmExplanation && rec.llmExplanation.trim().length > 0
      ? rec.llmExplanation
      : rec.reason ?? 'Sem narrativa registrada para esta recomendação.'

  return (
    <div className="px-2 md:px-0 py-2">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <Badge tone={statusTone(rec.status)}>{rec.status}</Badge>
        <Badge tone={guardrailTone(rec.guardrail.status)}>{rec.guardrail.status}</Badge>
        <Badge tone={riskTone(rec.risk)}>{rec.risk ?? 'sem risco'}</Badge>
        {rec.biddingLearning && (
          <Badge tone={biddingLearningTone(rec.biddingLearning.status)}>
            Bidding: {rec.biddingLearning.label}
          </Badge>
        )}
        <span className="font-mono text-xs text-ink-300">{rec.skill}</span>
      </div>

      <h1 className="font-display text-3xl text-ink-100">{rec.campaign.name}</h1>
      <div className="text-ink-300 font-mono text-sm mt-1 mb-8">
        {rec.campaign.id} ·{' '}
        <span className="text-ink-400">{rec.account.label ?? rec.account.id}</span>
      </div>

      <div className="bg-ink-800 hairline rounded-card max-w-3xl px-8 py-6 mb-10">
        <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-3">
          Narrativa
        </div>
        <p className="font-display italic text-lg text-ink-200 leading-relaxed">{explanation}</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-10">
        <Card>
          <CardHeader>
            <div className="font-display text-base text-ink-100">Mudança proposta</div>
          </CardHeader>
          <CardBody>
            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              Ação
            </div>
            <div className="text-ink-100 mb-5">{actionLabel(rec.action)}</div>

            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              Budget
            </div>
            <div className="flex items-baseline gap-3 mb-5">
              <span className="font-mono tabular-nums text-ink-300 text-sm">
                {fmtBrl(rec.current.budgetBrl)}
              </span>
              <span className="text-ink-400">→</span>
              <span className="font-mono tabular-nums text-ink-100 text-sm">
                {fmtBrl(rec.proposed.budgetBrl)}
              </span>
            </div>

            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              tROAS
            </div>
            <div className="flex items-baseline gap-3 mb-5">
              <span className="font-mono tabular-nums text-ink-300 text-sm">
                {fmtNumber(rec.current.targetRoas, 2)}
              </span>
              <span className="text-ink-400">→</span>
              <span className="font-mono tabular-nums text-ink-100 text-sm">
                {fmtNumber(rec.proposed.targetRoas, 2)}
              </span>
            </div>

            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              Δ %
            </div>
            <div
              className={`font-mono tabular-nums text-sm ${
                rec.changePercent === null || rec.changePercent === 0
                  ? 'text-ink-300'
                  : rec.changePercent > 0
                    ? 'text-sage'
                    : 'text-coral'
              }`}
            >
              {fmtPct(rec.changePercent)}
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-display text-base text-ink-100">Impacto esperado</div>
          </CardHeader>
          <CardBody>
            <div className="grid grid-cols-2 gap-x-4 gap-y-4">
              <LabeledValue
                label="Custo incremental"
                value={fmtBrl(rec.expected.incrementalCostBrl)}
              />
              <LabeledValue
                label="Receita incremental"
                value={fmtBrl(rec.expected.incrementalRevenueBrl)}
              />
              <LabeledValue
                label="ROAS marginal"
                value={fmtNumber(rec.expected.marginalRoas, 2)}
              />
              <LabeledValue
                label="COS projetado"
                value={fmtPct(rec.expected.projectedCos)}
              />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-display text-base text-ink-100">Sinais</div>
          </CardHeader>
          <CardBody>
            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              Confiança
            </div>
            <div className="mb-5">
              <ConfidenceBlock value={rec.confidence} />
            </div>

            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              Risco
            </div>
            <div className="mb-5">
              <Badge tone={riskTone(rec.risk)}>{rec.risk ?? 'desconhecido'}</Badge>
            </div>

            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              Razão
            </div>
            <div className="text-sm text-ink-200">{rec.reason ?? '—'}</div>

            {rec.guardrail.reason && (
              <>
                <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mt-5 mb-1">
                  Guardrail
                </div>
                <div className="text-sm text-ink-200">{rec.guardrail.reason}</div>
              </>
            )}

            {rec.troasDrift && rec.proposed.targetRoas !== null && rec.current.targetRoas !== null && rec.current.targetRoas !== 0 && (
              <div className="mt-6 flex flex-col gap-4">
                <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400">
                  Consumo dos caps de tROAS
                </div>
                <DriftBar
                  label="Hoje"
                  consumed={rec.troasDrift.todayPct}
                  proposed={Math.abs(
                    (rec.proposed.targetRoas - rec.current.targetRoas) /
                      rec.current.targetRoas,
                  )}
                  cap={rec.troasDrift.dailyCapPct}
                />
                <DriftBar
                  label="Últimos 7 dias"
                  consumed={rec.troasDrift.sevenDayPct}
                  proposed={Math.abs(
                    (rec.proposed.targetRoas - rec.current.targetRoas) /
                      rec.current.targetRoas,
                  )}
                  cap={rec.troasDrift.sevenDayCapPct}
                />
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <Tabs
        tabs={[
          {
            key: 'payload',
            label: 'Payload',
            content: (
              <pre className="bg-ink-900/50 hairline rounded-card p-4 font-mono text-xs text-ink-200 overflow-auto">
                {JSON.stringify(rec, null, 2)}
              </pre>
            ),
          },
          {
            key: 'chat',
            label: 'Chat history',
            content: (
              <div className="text-sm text-ink-300">
                Histórico do Google Chat aparecerá aqui após a aprovação.
              </div>
            ),
          },
          {
            key: 'exec',
            label: 'Execução',
            content: (
              <div className="text-sm text-ink-300">Nenhuma execução registrada.</div>
            ),
          },
          {
            key: 'outcome',
            label: 'Outcome 24h / 72h',
            content: (
              <div className="text-sm text-ink-300">Outcome ainda não computado.</div>
            ),
          },
        ]}
      />

      <div className="mt-8 text-[11px] font-mono text-ink-400">
        Criada {fmtRelative(rec.createdAt)} · atualizada {fmtRelative(rec.updatedAt)}
        {rec.expiresAt ? <> · expira em {fmtRelative(rec.expiresAt)}</> : null}
      </div>
    </div>
  )
}

/**
 * Full-screen pane rendered while the SPA is processing a Google Chat
 * Approve / Reject openLink click. Driven entirely by the URL's ?action= and
 * the parent's effect; this component is purely presentational.
 *
 * The approval has two phases the user perceives as one:
 *   1. POST /api/recommendations/:id/(approve|reject) — recorded synchronously
 *   2. fire-and-forget POST /api/execute/:id           — runs in background
 * On approve we show a 3-step indicator so the wait feels intentional;
 * on reject the second/third steps are skipped.
 */

const APPROVE_STEPS = [
  { key: 'record', label: 'Registrando decisão', detail: 'Salvando no audit trail' },
  { key: 'guardrail', label: 'Validando guardrails', detail: 'Limites de mudança e risco' },
  { key: 'apply', label: 'Enviando ao Google Ads', detail: 'Aplicando em background' },
] as const

const REJECT_STEPS = [
  { key: 'record', label: 'Registrando rejeição', detail: 'Salvando no audit trail' },
] as const

function useStepProgress(running: boolean, total: number) {
  // Walks a fake step cursor while we wait for the POST. The backend doesn't
  // emit progress events, so the wizard simulates 1 step / ~800ms — fast
  // enough to feel responsive, slow enough to read. Capped at total-1 so the
  // last tick lands exactly on success.
  const [step, setStep] = useState(0)
  useEffect(() => {
    if (!running) return
    setStep(0)
    const id = setInterval(() => {
      setStep((s) => (s < total - 1 ? s + 1 : s))
    }, 800)
    return () => clearInterval(id)
  }, [running, total])
  return step
}

function useCloseCountdown(active: boolean, seconds: number) {
  const [remaining, setRemaining] = useState(seconds)
  useEffect(() => {
    if (!active) return
    setRemaining(seconds)
    const id = setInterval(() => {
      setRemaining((r) => (r > 0 ? r - 1 : 0))
    }, 1000)
    return () => clearInterval(id)
  }, [active, seconds])
  return remaining
}

function CheckIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M3.5 8.5L6.5 11.5L12.5 5.5"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

function StepRow({
  state,
  label,
  detail,
}: {
  state: 'done' | 'active' | 'pending'
  label: string
  detail: string
}) {
  return (
    <li className="flex items-start gap-3 py-1">
      <span
        className={`mt-[2px] flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors duration-300 ${
          state === 'done'
            ? 'bg-sage text-ink-900'
            : state === 'active'
              ? 'bg-ink-700 text-ink-100'
              : 'bg-ink-700/40 text-ink-400'
        }`}
        aria-hidden="true"
      >
        {state === 'done' ? (
          <CheckIcon size={12} />
        ) : state === 'active' ? (
          <Spinner size={12} />
        ) : (
          <span className="block h-1 w-1 rounded-full bg-current" />
        )}
      </span>
      <span className="flex flex-col">
        <span
          className={`text-sm leading-5 transition-colors ${
            state === 'pending' ? 'text-ink-400' : 'text-ink-100'
          }`}
        >
          {label}
        </span>
        <span className="text-[11px] font-mono text-ink-400">{detail}</span>
      </span>
    </li>
  )
}

function AutoActionPane({
  action,
  status,
  error,
}: {
  action: 'approve' | 'reject'
  status: AutoActionStatus
  error: string | null
}) {
  const steps = action === 'approve' ? APPROVE_STEPS : REJECT_STEPS
  const activeStep = useStepProgress(status === 'running', steps.length)
  const closeIn = useCloseCountdown(status === 'success', 3)
  const verbProgress = action === 'approve' ? 'Aprovando recomendação' : 'Rejeitando recomendação'
  const verbDone = action === 'approve' ? 'Recomendação aprovada' : 'Recomendação rejeitada'
  const successDetail =
    action === 'approve'
      ? 'A mudança está sendo enviada ao Google Ads em background. Você pode acompanhar o status na tela de detalhes.'
      : 'A recomendação foi marcada como rejeitada. Nenhuma alteração será aplicada.'

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-b from-ink-900 via-ink-900 to-ink-800 text-ink-100 px-6">
      <div
        className="hairline rounded-card bg-ink-800/80 backdrop-blur-sm shadow-soft-lift p-10 max-w-md w-full"
        role="status"
        aria-live="polite"
      >
        {status === 'running' && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center gap-3">
              <Spinner size={18} />
              <div className="font-display text-xl text-ink-100">{verbProgress}…</div>
            </div>
            <ul className="flex flex-col gap-1">
              {steps.map((s, i) => (
                <StepRow
                  key={s.key}
                  state={i < activeStep ? 'done' : i === activeStep ? 'active' : 'pending'}
                  label={s.label}
                  detail={s.detail}
                />
              ))}
            </ul>
          </div>
        )}

        {status === 'success' && (
          <div className="flex flex-col items-center text-center gap-3 animate-in fade-in">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-sage text-ink-900">
              <CheckIcon size={22} />
            </span>
            <div className="font-display text-2xl">{verbDone}</div>
            <p className="text-sm text-ink-300 leading-relaxed">{successDetail}</p>
            <p className="mt-2 text-[10px] font-mono uppercase tracking-[0.08em] text-ink-400">
              {closeIn > 0
                ? `Fechando em ${closeIn}s`
                : 'Pode fechar esta aba'}
            </p>
          </div>
        )}

        {status === 'error' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <span
                className="flex h-9 w-9 items-center justify-center rounded-full bg-coral-wash text-coral font-display text-lg"
                aria-hidden="true"
              >
                !
              </span>
              <div className="font-display text-xl text-coral">Não foi possível processar</div>
            </div>
            <p className="text-sm text-ink-300 leading-relaxed">
              {error ?? 'Erro desconhecido. Tente novamente em alguns instantes.'}
            </p>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-4 py-2 bg-sage text-ink-900 rounded-[5px] text-sm font-medium hover:bg-sage/90"
              >
                Tentar novamente
              </button>
              <button
                type="button"
                onClick={() => window.close()}
                className="px-4 py-2 bg-ink-700 hairline rounded-[5px] text-sm hover:bg-ink-600"
              >
                Fechar
              </button>
            </div>
          </div>
        )}

        {status === 'idle' && (
          <div className="flex items-center gap-3 text-ink-300 font-mono text-xs uppercase tracking-[0.12em]">
            <Spinner size={12} />
            Preparando…
          </div>
        )}
      </div>
    </div>
  )
}
