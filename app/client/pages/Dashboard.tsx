import { Link } from 'react-router-dom'
import { useRecommendations } from '~/hooks/useRecommendations'
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
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
                    <TH>Skill</TH>
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
                      onClick={() => {
                        window.location.href = `/recommendations/${r.id}`
                      }}
                    >
                      <TD className="font-mono text-xs text-ink-300">{r.skill}</TD>
                      <TD>
                        <Link
                          to={`/recommendations/${r.id}`}
                          className="text-ink-100 hover:text-sage"
                        >
                          {r.campaign.name}
                        </Link>
                      </TD>
                      <TD className="text-ink-200">{actionLabel(r.action)}</TD>
                      <TD className="text-right font-mono tabular-nums text-ink-200">
                        {fmtPct(r.changePercent)}
                      </TD>
                      <TD>
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
