import { useParams } from 'react-router-dom'
import { useRecommendation } from '~/hooks/useRecommendation'
import { Card, CardBody, CardHeader } from '~/components/ui/Card'
import { Badge, guardrailTone, riskTone, statusTone } from '~/components/ui/Badge'
import { Tabs } from '~/components/ui/Tabs'
import { Spinner } from '~/components/ui/Spinner'
import { fmtBrl, fmtNumber, fmtPct, fmtRelative } from '~/lib/formatters'
import { actionLabel } from '~/lib/actionLabels'

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
