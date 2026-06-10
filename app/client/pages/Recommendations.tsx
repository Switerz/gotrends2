import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRecommendations } from '~/hooks/useRecommendations'
import { Card, CardBody } from '~/components/ui/Card'
import { Badge, guardrailTone, statusTone } from '~/components/ui/Badge'
import { Table, THead, TBody, TR, TH, TD } from '~/components/ui/Table'
import { EmptyState } from '~/components/ui/EmptyState'
import { Spinner } from '~/components/ui/Spinner'
import { fmtNumber, fmtPct, fmtRelative } from '~/lib/formatters'
import { actionLabel } from '~/lib/actionLabels'
import { ACCOUNTS, DEFAULT_ACCOUNT_ID } from '~/lib/constants'

const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Todos' },
  { value: 'pending', label: 'Pendentes' },
  { value: 'sent_to_chat', label: 'No chat' },
  { value: 'approved', label: 'Aprovadas' },
  { value: 'rejected', label: 'Rejeitadas' },
  { value: 'executing', label: 'Executando' },
  { value: 'executed', label: 'Executadas' },
  { value: 'failed', label: 'Falhas' },
]

function ConfidenceBar({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) {
    return <span className="font-mono text-ink-400 tabular-nums">—</span>
  }
  const pct = Math.max(0, Math.min(1, value))
  const tone =
    pct >= 0.6
      ? 'bg-sage'
      : pct >= 0.4
        ? 'bg-amber'
        : 'bg-coral'
  return (
    <div className="flex items-center gap-2 min-w-[88px]">
      <span className="font-mono tabular-nums text-xs text-ink-200">{fmtPct(pct, 0)}</span>
      <div className="flex-1 h-[5px] bg-ink-700 rounded-full overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${(pct * 100).toFixed(0)}%` }} />
      </div>
    </div>
  )
}

export default function Recommendations() {
  const navigate = useNavigate()
  const [status, setStatus] = useState<string>('')
  const [accountId, setAccountId] = useState<string>(DEFAULT_ACCOUNT_ID)
  const [search, setSearch] = useState<string>('')

  const { data, error, isLoading } = useRecommendations({
    status: status || undefined,
    accountId,
    limit: 200,
  })

  const filtered = useMemo(() => {
    if (!data) return []
    const term = search.trim().toLowerCase()
    if (!term) return data
    return data.filter(
      (r) =>
        r.campaign.name.toLowerCase().includes(term) ||
        r.campaign.id.toLowerCase().includes(term),
    )
  }, [data, search])

  const reset = () => {
    setStatus('')
    setAccountId(DEFAULT_ACCOUNT_ID)
    setSearch('')
  }

  return (
    <div className="px-2 md:px-0 py-2">
      <h1 className="font-display text-4xl mb-1">Recomendações</h1>
      <p className="text-ink-300 mb-8">Tudo que o agente sugeriu, com guardrails e confiança.</p>

      <div className="flex flex-col md:flex-row md:items-center gap-3 mb-6">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="bg-ink-800 hairline rounded-card px-3 py-2 text-sm text-ink-100 focus:outline-none focus:ring-2 focus:ring-sage/30"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>

        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="bg-ink-800 hairline rounded-card px-3 py-2 text-sm text-ink-100 focus:outline-none focus:ring-2 focus:ring-sage/30"
        >
          {ACCOUNTS.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar campanha…"
          className="bg-ink-800 hairline rounded-card px-3 py-2 text-sm text-ink-100 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sage/30 flex-1 md:max-w-xs"
        />

        <button
          type="button"
          onClick={reset}
          className="text-sm text-sage hover:underline underline-offset-4 decoration-sage/40"
        >
          Limpar
        </button>
      </div>

      {error && (
        <div className="mb-6 hairline rounded-card bg-coral-wash/40 px-5 py-4 text-sm text-coral">
          Falha ao carregar: {String(error.message ?? error)}
        </div>
      )}

      <Card>
        <CardBody className="p-0">
          {isLoading ? (
            <div className="px-5 py-16 flex justify-center">
              <Spinner />
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-5 py-8">
              <EmptyState
                title="Nenhuma recomendação"
                description="Ajuste os filtros ou aguarde o próximo run do pipeline."
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
                  <TH className="text-right">ROAS marg.</TH>
                  <TH>Confiança</TH>
                  <TH>Guardrail</TH>
                  <TH>Status</TH>
                  <TH>Criada</TH>
                </tr>
              </THead>
              <TBody>
                {filtered.map((r) => (
                  <TR
                    key={r.id}
                    onClick={() => navigate(`/recommendations/${r.id}`)}
                  >
                    <TD>
                      <div className="text-ink-100">{r.campaign.name}</div>
                      <div className="font-mono text-[11px] text-ink-400">{r.campaign.id}</div>
                    </TD>
                    <TD className="font-mono text-xs text-ink-300">{r.skill}</TD>
                    <TD className="text-ink-200">{actionLabel(r.action)}</TD>
                    <TD className="text-right font-mono tabular-nums">
                      <span
                        className={
                          r.changePercent === null || r.changePercent === 0
                            ? 'text-ink-300'
                            : r.changePercent > 0
                              ? 'text-sage'
                              : 'text-coral'
                        }
                      >
                        {fmtPct(r.changePercent)}
                      </span>
                    </TD>
                    <TD className="text-right font-mono tabular-nums text-ink-200">
                      {fmtNumber(r.expected.marginalRoas, 2)}
                    </TD>
                    <TD>
                      <ConfidenceBar value={r.confidence} />
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
