// src/http/dto/run.ts
//
// HTTP-facing shape for a `model_runs` row. Mirrors the DB columns one-for-one
// but in camelCase and with the input window collapsed into an object.

import type { ModelRunRow } from '@/db/types'

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

export function toRunDTO(row: ModelRunRow): RunDTO {
  return {
    id: row.run_id,
    accountId: row.account_id,
    runTs: row.run_ts,
    pipelineVersion: row.pipeline_version,
    status: row.status,
    nCampaignsScanned: row.n_campaigns_scanned,
    nRecommendations: row.n_recommendations,
    inputWindow: { start: row.input_window_start, end: row.input_window_end },
    notes: row.notes,
  }
}
