import useSWR from 'swr'
import { fetcher } from '~/lib/api'

export interface RecommendationStats {
  windowDays: number
  windowStart: string
  totals: {
    total: number
    decided: number
    executed: number
  }
  byStatus: {
    pending: number
    sent_to_chat: number
    approved: number
    executing: number
    executed: number
    failed: number
    rejected: number
    expired: number
  }
  rates: {
    approvalRate: number | null
    engagementRate: number | null
    executionSuccessRate: number | null
  }
}

export function useRecommendationStats(days = 7) {
  return useSWR<RecommendationStats>(
    `/api/recommendations/stats?days=${days}`,
    fetcher,
  )
}
