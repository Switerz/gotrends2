import { useNavigate } from 'react-router-dom'
import { useRuns } from '~/hooks/useRuns'
import { DEFAULT_ACCOUNT_ID } from '~/lib/constants'
import { Card, CardBody } from '~/components/ui/Card'
import { Badge, statusTone } from '~/components/ui/Badge'
import { Table, THead, TBody, TR, TH, TD } from '~/components/ui/Table'
import { EmptyState } from '~/components/ui/EmptyState'
import { Spinner } from '~/components/ui/Spinner'
import { fmtRelative } from '~/lib/formatters'

function windowLabel(w: { start: string | null; end: string | null }): string {
  if (!w.start && !w.end) return '—'
  const s = w.start ? w.start.slice(0, 10) : '?'
  const e = w.end ? w.end.slice(0, 10) : '?'
  return `${s} → ${e}`
}

export default function Runs() {
  const navigate = useNavigate()
  const { data, error, isLoading } = useRuns(DEFAULT_ACCOUNT_ID, 100)
  const list = data ?? []

  return (
    <div className="px-2 md:px-0 py-2">
      <h1 className="font-display text-4xl mb-1">Runs</h1>
      <p className="text-ink-300 mb-8">Histórico de execuções do pipeline.</p>

      {error && (
        <div className="mb-6 hairline rounded-card bg-coral-wash/40 px-5 py-4 text-sm text-coral">
          Falha ao carregar runs: {String(error.message ?? error)}
        </div>
      )}

      <Card>
        <CardBody className="p-0">
          {isLoading ? (
            <div className="px-5 py-16 flex justify-center">
              <Spinner />
            </div>
          ) : list.length === 0 ? (
            <div className="px-5 py-8">
              <EmptyState
                title="Sem runs ainda"
                description="O pipeline ainda não rodou para esta conta."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Run</TH>
                  <TH>Quando</TH>
                  <TH>Pipeline</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Campanhas</TH>
                  <TH className="text-right">Recs</TH>
                  <TH>Janela</TH>
                </tr>
              </THead>
              <TBody>
                {list.map((r) => (
                  <TR key={r.id} onClick={() => navigate(`/runs/${r.id}`)}>
                    <TD className="font-mono text-xs text-ink-100">{r.id.slice(0, 8)}</TD>
                    <TD className="text-ink-300 text-xs">{fmtRelative(r.runTs)}</TD>
                    <TD>
                      <span className="inline-block font-mono text-[11px] text-ink-200 bg-ink-700 hairline rounded-pill px-2 py-0.5">
                        {r.pipelineVersion}
                      </span>
                    </TD>
                    <TD>
                      <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                    </TD>
                    <TD className="text-right font-mono tabular-nums text-ink-200">
                      {r.nCampaignsScanned ?? '—'}
                    </TD>
                    <TD className="text-right font-mono tabular-nums text-ink-200">
                      {r.nRecommendations ?? '—'}
                    </TD>
                    <TD className="font-mono text-xs text-ink-300">
                      {windowLabel(r.inputWindow)}
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
