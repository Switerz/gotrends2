// Client-side mirror of HTTP DTOs (see app/src/http/dto/). We re-declare
// them here so the client bundle does not pull in server code. Keep in sync
// with `app/src/http/dto/*.ts` and `app/src/http/routes/decisionLog.ts`.

export interface RecommendationDTO {
  id: string
  runId: string
  account: { id: string; label?: string | null }
  campaign: { id: string; name: string }
  skill: string
  action: string
  changePercent: number | null
  current: { budgetBrl: number | null; targetRoas: number | null }
  proposed: { budgetBrl: number | null; targetRoas: number | null }
  expected: {
    incrementalCostBrl: number | null
    incrementalRevenueBrl: number | null
    marginalRoas: number | null
    projectedCos: number | null
  }
  observedRoas7d: number | null
  confidence: number | null
  risk: string | null
  guardrail: { status: string; reason: string | null }
  reason: string | null
  llmExplanation: string | null
  status: string
  troasDrift?: {
    todayPct: number
    sevenDayPct: number
    dailyCapPct: number
    sevenDayCapPct: number
  }
  biddingLearning?: {
    status: 'stable' | 'learning' | 'limited' | 'unknown'
    label: string
  }
  verification?: {
    status: 'match' | 'drifted' | 'reverted' | 'unavailable'
    observedValue: number | null
    verifiedAt: string
  } | null
  expiresAt: string | null
  createdAt: string
  updatedAt: string
}

export interface RunDTO {
  id: string
  accountId: string
  runTs: string
  pipelineVersion: string
  status: string
  nCampaignsScanned: number | null
  nRecommendations: number | null
  inputWindow: { start: string | null; end: string | null }
  notes: string | null
}

export interface SkillDTO {
  key: string
  displayName: string
  category: 'diagnostic' | 'optimization' | 'reporting'
  description: string
}

export interface DecisionLogRow {
  recommendation_id: string
  run_id: string
  account_id: string
  campaign_id: string
  skill_type: string
  recommended_action: string
  status: string
  guardrail_status: string
  decision?: string | null
  decided_by?: string | null
  decided_at?: string | null
  execution_status?: string | null
  outcome_verdict?: string | null
  created_at: string
}
