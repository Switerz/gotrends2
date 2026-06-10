import { useMemo } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useRecommendations } from '~/hooks/useRecommendations'
import { ACCOUNTS } from '~/lib/constants'
import { Card, CardBody, CardHeader } from '~/components/ui/Card'
import { Badge, guardrailTone, statusTone } from '~/components/ui/Badge'
import { Table, THead, TBody, TR, TH, TD } from '~/components/ui/Table'
import { EmptyState } from '~/components/ui/EmptyState'
import { Spinner } from '~/components/ui/Spinner'
import { fmtPct, fmtRelative } from '~/lib/formatters'
import { actionLabel } from '~/lib/actionLabels'

export default function Campaign() {
  const { accountId, campaignId } = useParams<{ accountId: string; campaignId: string }>()
  const navigate = useNavigate()
  // TODO: ideally /api/campaigns/:accountId/:campaignId surfaces metadata
  // (name, status, last 7d KPIs). Until that lands (Phase 7+) we hydrate
  // from the recommendations stream.
  const { data, error, isLoading } = useRecommendations({ accountId, limit: 500 })

  const accountLabel =
    ACCOUNTS.find((a) => a.id === accountId)?.label ?? accountId ?? '—'

  const recsForCampaign = useMemo(
    () => (data && campaignId ? data.filter((r) => r.campaign.id === campaignId) : []),
    [data, campaignId],
  )

  const campaignName = recsForCampaign[0]?.campaign.name

  return (
    <div className="px-2 md:px-0 py-2">
      <div className="text-[10px] uppercase tracking-[0.08em] font-mono text-ink-400 mb-2">
        {accountLabel}
      </div>
      <h1 className="font-display text-3xl text-ink-100">
        {campaignName ?? 'Campanha'}
      </h1>
      <div className="text-ink-300 font-mono text-sm mt-1 mb-8">{campaignId}</div>

      {error && (
        <div className="mb-6 hairline rounded-card bg-coral-wash/40 px-5 py-4 text-sm text-coral">
          Falha ao carregar histórico: {String(error.message ?? error)}
        </div>
      )}

      <Card>
        <CardHeader>
          <div className="font-display text-base text-ink-100">Histórico de recomendações</div>
        </CardHeader>
        <CardBody className="p-0">
          {isLoading ? (
            <div className="px-5 py-16 flex justify-center">
              <Spinner />
            </div>
          ) : recsForCampaign.length === 0 ? (
            <div className="px-5 py-8">
              <EmptyState
                title="Sem recomendações"
                description="Nenhuma recomendação registrada para esta campanha ainda."
              />
            </div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Skill</TH>
                  <TH>Ação</TH>
                  <TH className="text-right">Δ %</TH>
                  <TH>Guardrail</TH>
                  <TH>Status</TH>
                  <TH>Criada</TH>
                </tr>
              </THead>
              <TBody>
                {recsForCampaign.map((r) => (
                  <TR key={r.id} onClick={() => navigate(`/recommendations/${r.id}`)}>
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
                    <TD className="text-ink-300 text-xs">{fmtRelative(r.createdAt)}</TD>
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
