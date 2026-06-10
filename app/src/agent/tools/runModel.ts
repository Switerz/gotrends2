// src/agent/tools/runModel.ts
//
// Atomic tool: dispatch a single model port by name. Used by the agent and the
// CLI to call any of the 9 model ports without importing them individually.
//
// Each branch accepts the model's natural input shape and returns its natural
// output. Callers are responsible for shaping inputs correctly — the goal here
// is mechanical dispatch, not validation.

import { buildBaselineTrendFeatures } from '@/models/baselineTrend'
import { addRobustAnomalyFlags } from '@/models/anomalyDetection'
import { addConfidenceFeatures } from '@/models/confidenceScore'
import {
  buildCampaignElasticityFeatures,
  type DailyInputRow,
} from '@/models/marginalElasticity'
import { addSaturationFeatures, type SaturationInputRow } from '@/models/saturation'
import { addLeverDiagnosis, type LeverInputRow } from '@/models/leverDiagnosis'
import { addCampaignScores } from '@/models/campaignScores'
import { applyGuardrails, type GuardrailInputRow } from '@/models/constraintsOptimizer'
import { projectedCos } from '@/models/projectedCos'

export type ModelName =
  | 'baselineTrend'
  | 'anomalyDetection'
  | 'confidenceScore'
  | 'marginalElasticity'
  | 'saturation'
  | 'leverDiagnosis'
  | 'campaignScores'
  | 'constraintsOptimizer'
  | 'projectedCos'

interface ProjectedCosInput {
  current_media_cost: number | null | undefined
  current_revenue: number | null | undefined
  delta_media_cost: number | null | undefined
  expected_incremental_revenue: number | null | undefined
}

function asRowArray(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) {
    throw new Error(`runModel: expected an array of rows, got ${typeof input}`)
  }
  return input as Array<Record<string, unknown>>
}

/**
 * Dispatch a model by name. Throws on unknown names.
 *
 * NOTE: projectedCos takes a single unit case (object), not an array, because
 * the underlying function is a pure 4-arg scalar helper.
 */
export async function runModel(name: string, input: unknown): Promise<unknown> {
  switch (name) {
    case 'baselineTrend':
      return buildBaselineTrendFeatures(asRowArray(input))
    case 'anomalyDetection':
      return addRobustAnomalyFlags(asRowArray(input))
    case 'confidenceScore':
      return addConfidenceFeatures(
        asRowArray(input) as Parameters<typeof addConfidenceFeatures>[0],
      )
    case 'marginalElasticity':
      return buildCampaignElasticityFeatures(asRowArray(input) as DailyInputRow[])
    case 'saturation':
      return addSaturationFeatures(asRowArray(input) as SaturationInputRow[])
    case 'leverDiagnosis':
      return addLeverDiagnosis(asRowArray(input) as LeverInputRow[])
    case 'campaignScores':
      return addCampaignScores(
        asRowArray(input) as Parameters<typeof addCampaignScores>[0],
      )
    case 'constraintsOptimizer':
      return applyGuardrails(asRowArray(input) as GuardrailInputRow[])
    case 'projectedCos': {
      if (
        typeof input !== 'object' ||
        input === null ||
        Array.isArray(input)
      ) {
        throw new Error(
          'runModel(projectedCos): expected an object with current_media_cost, current_revenue, delta_media_cost, expected_incremental_revenue',
        )
      }
      const i = input as ProjectedCosInput
      return projectedCos(
        i.current_media_cost,
        i.current_revenue,
        i.delta_media_cost,
        i.expected_incremental_revenue,
      )
    }
    default:
      throw new Error(`runModel: unknown model name "${name}"`)
  }
}
