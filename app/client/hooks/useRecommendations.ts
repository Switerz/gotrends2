import useSWR from 'swr'
import type { RecommendationDTO } from '~/lib/types'
import { fetcher } from '~/lib/api'

interface Options {
  status?: string
  accountId?: string
  limit?: number
}

export function useRecommendations(opts: Options = {}) {
  const params = new URLSearchParams()
  if (opts.status) params.set('status', opts.status)
  if (opts.accountId) params.set('account_id', opts.accountId)
  if (opts.limit) params.set('limit', String(opts.limit))
  const qs = params.toString()
  const url = `/api/recommendations${qs ? `?${qs}` : ''}`
  return useSWR<RecommendationDTO[]>(url, fetcher)
}
