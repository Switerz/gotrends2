import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useRun } from '~/hooks/useRun'
import { useRecommendations } from '~/hooks/useRecommendations'
import { Card, CardBody, CardHeader } from '~/components/ui/Card'
import { Badge, guardrailTone, statusTone } from '~/components/ui/Badge'
import { Table, THead, TBody, TR, TH, TD } from '~/components/ui/Table'
import { EmptyState } from '~/components/ui/EmptyState'
import { Spinner } from '~/components/ui/Spinner'
import { fmtPct, fmtRelative } from '~/lib/formatters'
import { actionLabel } from '~/lib/actionLabels'

export default function RunDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { data: run, error, isLoading } = useRun(id)
  // TODO: replace this client-side filter with /api/runs/:id/recommendations
  // when that endpoint exists (Phase 7+).
  const { data: allRecs } = useRecommendations({ limit: 500 })

  const recsForRun = useMemo(
    () => (allRecs && id ? allRecs.filter((r) => r.runId === id) : []),
    [allRecs, id],
  )

  if (isLoading) {
    return (
      <div className="py-16 flex justify-center">
        <Spinner size={24} />
      </div>
    )
  }

  if (error) {
    return (
      <div className="py-10 hairline rounded-card bg-coral-wash/40 px-5 py-4 text-sm text-coral">
        Falha ao carregar run: {String(error.message ?? error)}
      </div>
    )
  }

  if (!run) {
    return <div className="py-10 text-ink-300">Run não encontrada.</div>
  }

  return (
    <div className="px-2 md:px-0 py-2">
      <h1 className="font-display text-4xl text-ink-100">
        Run <span className="font-mono text-3xl text-ink-200">{run.id.slice(0, 8)}</span>
      </h1>
      <div className="text-ink-300 mt-1 mb-8">
        <span className="font-mono">{run.pipelineVersion}</span> · {fmtRelative(run.runTs)}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
        <Card>
          <CardHeader>
            <div className="font-display text-base text-ink-100">Configuração</div>
          </CardHeader>
          <CardBody>
            <dl className="grid grid-cols-[120px_1fr] gap-y-3 text-sm">
              <dt className="font-mono text-xs text-ink-400 uppercase tracking-[0.08em]">
                Account
              </dt>
              <dd className="font-mono tabular-nums text-ink-200">{run.accountId}</dd>

              <dt className="font-mono text-xs text-ink-400 uppercase tracking-[0.08em]">
                Pipeline
              </dt>
              <dd className="font-mono text-ink-200">{run.pipelineVersion}</dd>

              <dt className="font-mono text-xs text-ink-400 uppercase tracking-[0.08em]">
                Janela
              </dt>
              <dd className="font-mono text-ink-200 text-xs">
                {run.inputWindow.start?.slice(0, 10) ?? '?'} →{' '}
                {run.inputWindow.end?.slice(0, 10) ?? '?'}
              </dd>

              <dt className="font-mono text-xs text-ink-400 uppercase tracking-[0.08em]">
                Status
              </dt>
              <dd>
                <Badge tone={statusTone(run.status)}>{run.status}</Badge>
              </dd>
            </dl>
          </CardBody>
        </Card>

        <Card>
          <CardHeader>
            <div className="font-display text-base text-ink-100">Resultados</div>
          </CardHeader>
          <CardBody>
            <dl className="grid grid-cols-[180px_1fr] gap-y-3 text-sm">
              <dt className="font-mono text-xs text-ink-400 uppercase tracking-[0.08em]">
                Campanhas escaneadas
              </dt>
              <dd className="font-mono tabular-nums text-ink-100">
                {run.nCampaignsScanned ?? '—'}
              </dd>

              <dt className="font-mono text-xs text-ink-400 uppercase tracking-[0.08em]">
                Recomendações
              </dt>
              <dd className="font-mono tabular-nums text-ink-100">
                {run.nRecommendations ?? '—'}
              </dd>

              <dt className="font-mono text-xs text-ink-400 uppercase tracking-[0.08em]">
                Notas
              </dt>
              <dd className="text-ink-200">{run.notes ?? '—'}</dd>
            </dl>
          </CardBody>
        </Card>
      </div>

      <h2 className="font-display text-2xl text-ink-100 mb-4">
        Recomendações geradas neste run
      </h2>

      <Card>
        <CardBody className="p-0">
          {recsForRun.length === 0 ? (
            <div className="px-5 py-8">
              <EmptyState
                title="Sem recomendações"
                description="Este run não gerou recomendações para esta conta."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Campanha</TH>
                  <TH>Skill</TH>
                  <TH>Ação</TH>
                  <TH className="text-right">Δ %</TH>
                  <TH>Guardrail</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {recsForRun.map((r) => (
                  <TR key={r.id} onClick={() => navigate(`/recommendations/${r.id}`)}>
                    <TD>
                      <div className="text-ink-100">{r.campaign.name}</div>
                      <div className="font-mono text-[11px] text-ink-400">{r.campaign.id}</div>
                    </TD>
                    <TD className="font-mono text-xs text-ink-300">{r.skill}</TD>
                    <TD className="text-ink-200">{actionLabel(r.action)}</TD>
                    <TD className="text-right font-mono tabular-nums text-ink-200">
                      {fmtPct(r.changePercent)}
                    </TD>
                    <TD>
                      <Badge tone={guardrailTone(r.guardrail.status)}>{r.guardrail.status}</Badge>
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
    </div>
  )
}
