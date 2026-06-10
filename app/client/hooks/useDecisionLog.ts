import useSWR from 'swr'
import type { DecisionLogRow } from '~/lib/types'
import { fetcher } from '~/lib/api'

export function useDecisionLog(accountId?: string, limit = 200) {
  const params = new URLSearchParams()
  if (accountId) params.set('account_id', accountId)
  params.set('limit', String(limit))
  return useSWR<DecisionLogRow[]>(`/api/decision-log?${params}`, fetcher)
}
