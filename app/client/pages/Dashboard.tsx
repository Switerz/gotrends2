import { Link, useNavigate } from 'react-router-dom'
import { useRecommendations } from '~/hooks/useRecommendations'
import { useRecommendationStats } from '~/hooks/useRecommendationStats'
import { useRuns } from '~/hooks/useRuns'
import { DEFAULT_ACCOUNT_ID } from '~/lib/constants'
import { Stat } from '~/components/ui/Stat'
import { Card, CardHeader, CardBody } from '~/components/ui/Card'
import { Badge, statusTone } from '~/components/ui/Badge'
import { Table, THead, TBody, TR, TH, TD } from '~/components/ui/Table'
import { EmptyState } from '~/components/ui/EmptyState'
import { Spinner } from '~/components/ui/Spinner'
import { fmtPct, fmtRelative } from '~/lib/formatters'
import { actionLabel } from '~/lib/actionLabels'

const ONE_DAY_MS = 24 * 60 * 60 * 1000

export default function Dashboard() {
  const navigate = useNavigate()
  const recs = useRecommendations()
  const runs = useRuns(DEFAULT_ACCOUNT_ID, 5)

  const loading = recs.isLoading || runs.isLoading
  const recsErr = recs.error
  const runsErr = runs.error
  const list = recs.data ?? []
  const runList = runs.data ?? []

  const now = Date.now()
  const counts = {
    pending: list.filter((r) => r.status === 'pending').length,
    sent: list.filter((r) => r.status === 'sent_to_chat').length,
    approvedToday: list.filter(
      (r) =>
        (r.status === 'approved' || r.status === 'executed') &&
        now - new Date(r.updatedAt).getTime() <= ONE_DAY_MS,
    ).length,
    failed: list.filter((r) => r.status === 'failed').length,
  }

  const latest = [...list]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8)

  return (
    <div className="px-2 md:px-0 py-2">
      <h1 className="font-display text-4xl mb-1">Dashboard</h1>
      <p className="text-ink-300 mb-8">Visão geral das recomendações ativas.</p>

      {recsErr && (
        <div className="mb-6 hairline rounded-card bg-coral-wash/40 px-5 py-4 text-sm text-coral">
          Falha ao carregar recomendações: {String(recsErr.message ?? recsErr)}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
        <Stat label="Pendentes" value={loading ? '—' : counts.pending} />
        <Stat label="Enviadas ao chat" value={loading ? '—' : counts.sent} />
        <Stat label="Aprovadas hoje" value={loading ? '—' : counts.approvedToday} />
        <Stat
          label="Falhas"
          value={loading ? '—' : counts.failed}
          delta={counts.failed > 0 ? { value: '↑', tone: 'coral' } : undefined}
        />
      </div>

      <ApprovalRatesTile />

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <div className="font-display text-lg text-ink-100">Últimas recomendações</div>
          </CardHeader>
          <CardBody className="p-0">
            {loading ? (
              <div className="px-5 py-10 flex justify-center">
                <Spinner />
              </div>
            ) : latest.length === 0 ? (
              <div className="px-5 py-8">
                <EmptyState
                  title="Sem dados ainda"
                  description="Quando o pipeline rodar, recomendações aparecem aqui."
                />
              </div>
            ) : (
              <Table>
                <THead>
                  <tr>
                    <TH>Campanha</TH>
                    <TH>Ação</TH>
                    <TH className="text-right">Δ %</TH>
                    <TH>Status</TH>
                  </tr>
                </THead>
                <TBody>
                  {latest.map((r) => (
                    <TR
                      key={r.id}
                      onClick={() => navigate(`/recommendations/${r.id}`)}
                    >
                      <TD className="py-2.5">
                        <Link
                          to={`/recommendations/${r.id}`}
                          title={r.campaign.name}
                          className="block text-ink-100 hover:text-sage truncate max-w-[180px]"
                        >
                          {r.campaign.name}
                        </Link>
                        <div
                          className="font-mono text-[10px] text-ink-400 truncate max-w-[180px]"
                          title={r.skill}
                        >
                          {r.skill}
                        </div>
                      </TD>
                      <TD className="py-2.5 text-xs text-ink-200">{actionLabel(r.action)}</TD>
                      <TD className="py-2.5 text-right font-mono tabular-nums text-ink-200">
                        {fmtPct(r.changePercent)}
                      </TD>
                      <TD className="py-2.5">
                        <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-display text-lg text-ink-100">Runs recentes</div>
          </CardHeader>
          <CardBody className="p-0">
            {runsErr ? (
              <div className="px-5 py-6 text-sm text-coral">
                Falha ao carregar runs: {String(runsErr.message ?? runsErr)}
              </div>
            ) : loading ? (
              <div className="px-5 py-10 flex justify-center">
                <Spinner />
              </div>
            ) : runList.length === 0 ? (
              <div className="px-5 py-8">
                <EmptyState
                  title="Sem runs ainda"
                  description="Os runs do pipeline aparecem aqui assim que o agente roda."
                />
              </div>
            ) : (
              <ul>
                {runList.map((run) => (
                  <li
                    key={run.id}
                    className="hairline-b last:border-0 px-5 py-4 transition-colors duration-200 ease-editorial hover:bg-ink-700/40"
                  >
                    <Link to={`/runs/${run.id}`} className="flex items-center justify-between">
                      <div>
                        <div className="font-mono text-xs text-ink-100">
                          {run.id.slice(0, 8)}
                        </div>
                        <div className="text-[11px] text-ink-400 mt-1">
                          {fmtRelative(run.runTs)} ·{' '}
                          <span className="font-mono tabular-nums">
                            {run.nRecommendations ?? 0}
                          </span>{' '}
                          recs
                        </div>
                      </div>
                      <Badge tone={statusTone(run.status)}>{run.status}</Badge>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  )
}

/**
 * 7-day approval analytics — three rate metrics + a mini status breakdown.
 * Designed to sit between the headline counters and the lists so it gives
 * an immediate health pulse without competing with the per-rec views.
 */
function ApprovalRatesTile() {
  const { data, error, isLoading } = useRecommendationStats(7)

  if (error) {
    return (
      <div className="mb-10 hairline rounded-card bg-coral-wash/40 px-5 py-4 text-sm text-coral">
        Falha ao carregar métricas: {String(error.message ?? error)}
      </div>
    )
  }
  if (isLoading || !data) {
    return (
      <div className="mb-10 hairline rounded-card bg-ink-800 px-5 py-6 flex justify-center">
        <Spinner />
      </div>
    )
  }

  const fmtRate = (r: number | null) => (r === null ? '—' : `${r.toFixed(1).replace('.', ',')}%`)
  const toneFor = (rate: number | null, healthyAbove: number): string =>
    rate === null
      ? 'text-ink-300'
      : rate >= healthyAbove
        ? 'text-sage'
        : rate >= healthyAbove * 0.5
          ? 'text-amber'
          : 'text-coral'

  return (
    <Card className="mb-10">
      <CardHeader>
        <div className="flex items-baseline justify-between">
          <div className="font-display text-lg text-ink-100">Taxas de aprovação · 7 dias</div>
          <div className="font-mono text-[11px] text-ink-400 uppercase tracking-[0.08em]">
            {data.totals.total} recs · {data.totals.decided} decididas · {data.totals.executed} executadas
          </div>
        </div>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-6">
          <div>
            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              Aprovação
            </div>
            <div className={`font-display text-3xl tabular-nums ${toneFor(data.rates.approvalRate, 60)}`}>
              {fmtRate(data.rates.approvalRate)}
            </div>
            <div className="text-[11px] text-ink-400 mt-1">aprovadas / decididas</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              Engajamento
            </div>
            <div className={`font-display text-3xl tabular-nums ${toneFor(data.rates.engagementRate, 70)}`}>
              {fmtRate(data.rates.engagementRate)}
            </div>
            <div className="text-[11px] text-ink-400 mt-1">decididas / geradas</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-1">
              Execução
            </div>
            <div className={`font-display text-3xl tabular-nums ${toneFor(data.rates.executionSuccessRate, 90)}`}>
              {fmtRate(data.rates.executionSuccessRate)}
            </div>
            <div className="text-[11px] text-ink-400 mt-1">executadas / (executadas + falhas)</div>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 font-mono text-xs">
          <StatusCount label="pending" n={data.byStatus.pending} tone="neutral" />
          <StatusCount label="sent_to_chat" n={data.byStatus.sent_to_chat} tone="cobalt" />
          <StatusCount label="approved" n={data.byStatus.approved} tone="sage" />
          <StatusCount label="executing" n={data.byStatus.executing} tone="cobalt" />
          <StatusCount label="executed" n={data.byStatus.executed} tone="sage" />
          <StatusCount label="failed" n={data.byStatus.failed} tone="coral" />
          <StatusCount label="rejected" n={data.byStatus.rejected} tone="coral" />
          <StatusCount label="expired" n={data.byStatus.expired} tone="amber" />
        </div>
      </CardBody>
    </Card>
  )
}

function StatusCount({
  label,
  n,
  tone,
}: {
  label: string
  n: number
  tone: 'sage' | 'amber' | 'coral' | 'cobalt' | 'neutral'
}) {
  const colour: Record<typeof tone, string> = {
    sage: 'text-sage',
    amber: 'text-amber',
    coral: 'text-coral',
    cobalt: 'text-cobalt',
    neutral: 'text-ink-200',
  }
  return (
    <div className="hairline rounded-card px-3 py-2 bg-ink-800/50">
      <div className="text-[9px] uppercase tracking-[0.08em] text-ink-400">{label}</div>
      <div className={`tabular-nums text-lg ${colour[tone]}`}>{n}</div>
    </div>
  )
}
