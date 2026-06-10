import useSWR from 'swr'
import type { RecommendationDTO } from '~/lib/types'
import { fetcher } from '~/lib/api'

export function useRecommendation(id: string | undefined) {
  return useSWR<RecommendationDTO>(id ? `/api/recommendations/${id}` : null, fetcher)
}
