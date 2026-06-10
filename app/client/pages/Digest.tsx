import { useMemo } from 'react'
import { useRecommendations } from '~/hooks/useRecommendations'
import { Card, CardBody, CardHeader } from '~/components/ui/Card'
import { Stat } from '~/components/ui/Stat'
import { Badge, guardrailTone } from '~/components/ui/Badge'
import { Spinner } from '~/components/ui/Spinner'
import { EmptyState } from '~/components/ui/EmptyState'
import { fmtBrl } from '~/lib/formatters'

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000

export default function Digest() {
  const { data, error, isLoading } = useRecommendations({ limit: 1000 })
  const list = data ?? []

  const weekly = useMemo(() => {
    const now = Date.now()
    const lastWeek = list.filter(
      (r) => now - new Date(r.createdAt).getTime() <= ONE_WEEK_MS,
    )
    const approved = lastWeek
      .filter((r) => r.status === 'approved' || r.status === 'executed')
      .sort(
        (a, b) =>
          (b.expected.incrementalRevenueBrl ?? 0) -
          (a.expected.incrementalRevenueBrl ?? 0),
      )
    const blocked = lastWeek.filter((r) => r.guardrail.status === 'blocked')
    return {
      total: lastWeek.length,
      pending: lastWeek.filter((r) => r.status === 'pending').length,
      approved: approved.length,
      blocked: blocked.length,
      topApproved: approved.slice(0, 5),
      topBlocked: blocked.slice(0, 3),
    }
  }, [list])

  return (
    <div className="px-2 md:px-0 py-2">
      <h1 className="font-display text-4xl mb-1">Digest Semanal</h1>
      <p className="text-ink-300 mb-8">Resumo executivo dos últimos 7 dias.</p>

      {error && (
        <div className="mb-6 hairline rounded-card bg-coral-wash/40 px-5 py-4 text-sm text-coral">
          Falha ao carregar dados: {String(error.message ?? error)}
        </div>
      )}

      {isLoading ? (
        <div className="py-16 flex justify-center">
          <Spinner />
        </div>
      ) : (
        <>
          <section className="mb-12">
            <h2 className="font-display text-2xl text-ink-100 mb-4">Esta semana</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              <Stat label="Total" value={weekly.total} />
              <Stat label="Pendentes" value={weekly.pending} />
              <Stat label="Aprovadas" value={weekly.approved} />
              <Stat
                label="Bloqueadas"
                value={weekly.blocked}
                delta={weekly.blocked > 0 ? { value: '⚠', tone: 'coral' } : undefined}
              />
            </div>
          </section>

          <section className="mb-12">
            <h2 className="font-display text-2xl text-ink-100 mb-4">Destaques</h2>
            <Card>
              <CardBody className="p-0">
                {weekly.topApproved.length === 0 ? (
                  <div className="px-5 py-8">
                    <EmptyState
                      title="Sem destaques"
                      description="Nenhuma recomendação aprovada nos últimos 7 dias."
                    />
                  </div>
                ) : (
                  <ul>
                    {weekly.topApproved.map((r) => (
                      <li
                        key={r.id}
                        className="hairline-b last:border-0 px-5 py-4 flex items-center justify-between"
                      >
                        <div>
                          <div className="text-ink-100">{r.campaign.name}</div>
                          <div className="font-mono text-[11px] text-ink-400">{r.skill}</div>
                        </div>
                        <div className="font-mono tabular-nums text-sm text-sage">
                          {fmtBrl(r.expected.incrementalRevenueBrl)}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </section>

          <section className="mb-12">
            <h2 className="font-display text-2xl text-ink-100 mb-4">Bloqueadas</h2>
            <Card>
              <CardHeader>
                <div className="text-sm text-ink-300">
                  <span className="font-mono tabular-nums text-ink-100">{weekly.blocked}</span>{' '}
                  recomendação(ões) com guardrail bloqueado nos últimos 7 dias.
                </div>
              </CardHeader>
              <CardBody className="p-0">
                {weekly.topBlocked.length === 0 ? (
                  <div className="px-5 py-6 text-sm text-ink-300">
                    Nenhuma recomendação bloqueada.
                  </div>
                ) : (
                  <ul>
                    {weekly.topBlocked.map((r) => (
                      <li
                        key={r.id}
                        className="hairline-b last:border-0 px-5 py-4 flex items-start justify-between gap-4"
                      >
                        <div className="flex-1">
                          <div className="text-ink-100">{r.campaign.name}</div>
                          <div className="text-sm text-ink-300 mt-1">
                            {r.guardrail.reason ?? 'Motivo não informado.'}
                          </div>
                        </div>
                        <Badge tone={guardrailTone(r.guardrail.status)}>
                          {r.guardrail.status}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>
          </section>

          <p className="text-[11px] text-ink-400 italic">
            Geração automatizada pelo agente GoTrends v2 — texto narrativo será gerado por LLM
            em Phase 8+.
          </p>
        </>
      )}
    </div>
  )
}
