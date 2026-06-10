// src/agent/skills/projectedCos.ts
//
// Optimization skill: project cost-of-sales for a batch of proposed budget changes.
// Wraps the pure projectedCos + cosStatus helpers from @/models/projectedCos.

import { projectedCos, cosStatus, DEFAULT_COS_LIMIT } from '@/models/projectedCos'
import type { Candidate, SkillDescriptor, SkillResult } from './types'

interface ProjectedCosUnitCase {
  campaign_id: string
  campaign_name?: string
  current_media_cost: number | null | undefined
  current_revenue: number | null | undefined
  delta_media_cost: number | null | undefined
  expected_incremental_revenue: number | null | undefined
}

interface ProjectedCosInput {
  account_id: string
  cases: ProjectedCosUnitCase[]
  cos_limit?: number
}

function isInput(x: unknown): x is ProjectedCosInput {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as { account_id?: unknown }).account_id === 'string' &&
    Array.isArray((x as { cases?: unknown }).cases)
  )
}

async function run(input: unknown): Promise<SkillResult> {
  if (!isInput(input)) {
    return { candidates: [], notes: 'projected_cos: invalid input shape' }
  }

  const limit = input.cos_limit ?? DEFAULT_COS_LIMIT
  const candidates: Candidate[] = input.cases.map(c => {
    const pc = projectedCos(
      c.current_media_cost,
      c.current_revenue,
      c.delta_media_cost,
      c.expected_incremental_revenue,
    )
    const status = cosStatus(pc, limit)
    return {
      account_id: input.account_id,
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name ?? c.campaign_id,
      skill_type: 'projected_cos',
      recommended_action: status === 'blocked' ? 'monitor' : 'monitor',
      projected_cos: pc,
      reason: status,
      meta: { projected_cos: pc, cos_status: status, cos_limit: limit },
    }
  })

  return {
    candidates,
    notes: `projected_cos: ${candidates.length} cases evaluated`,
  }
}

export const descriptor: SkillDescriptor = {
  key: 'projected_cos',
  displayName: 'Projected COS',
  category: 'optimization',
  description: 'Project cost-of-sales after a proposed change.',
  run,
}
