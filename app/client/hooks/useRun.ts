import useSWR from 'swr'
import type { RunDTO } from '~/lib/types'
import { fetcher } from '~/lib/api'

export function useRun(id: string | undefined) {
  return useSWR<RunDTO>(id ? `/api/runs/${id}` : null, fetcher)
}
