import useSWR from 'swr'
import type { RunDTO } from '~/lib/types'
import { fetcher } from '~/lib/api'

export function useRuns(accountId: string, limit = 50) {
  return useSWR<RunDTO[]>(
    accountId ? `/api/runs?account_id=${accountId}&limit=${limit}` : null,
    fetcher,
  )
}
