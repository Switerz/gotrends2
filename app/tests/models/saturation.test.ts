import { describe, it, expect } from 'vitest'
import {
  addSaturationFeatures,
  classifySaturation,
  DEFAULT_SATURATION_CONFIG,
} from '@/models/saturation'

describe('addSaturationFeatures', () => {
  it('returns [] for empty input', () => {
    expect(addSaturationFeatures([])).toEqual([])
  })

  it('classifies a single healthy row as low / room_to_scale', () => {
    const out = addSaturationFeatures([
      {
        campaign_id: 'c-1',
        proxy_target_roas: 2.0,
        marginal_roas: 2.5,
        elasticity: 0.9, // above moderate floor (0.7)
        impression_share: 0.7,
        lost_is_rank: 0.2,
      },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.saturation_level).toBe('low')
    expect(out[0]!.saturation_reason).toBe('room_to_scale')
    expect(out[0]!.pure_budget_increase_blocked).toBe(false)
  })

  it('falls back to campaign_avg_roas / campaign_type_avg_roas when proxy_target_roas column missing', () => {
    // Mimics pandas behaviour when the proxy_target_roas column is absent from the frame.
    const out = addSaturationFeatures([
      {
        campaign_id: 'c-1',
        marginal_roas: 1.0,
        elasticity: 0.5,
        impression_share: 0.4,
        lost_is_rank: 0.1,
        campaign_avg_roas: null,
        campaign_type_avg_roas: 3.0,
      },
      {
        campaign_id: 'c-2',
        marginal_roas: 5.0,
        elasticity: 0.9,
        impression_share: 0.4,
        lost_is_rank: 0.1,
        campaign_avg_roas: 4.0,
        campaign_type_avg_roas: 2.0,
      },
    ])
    expect(out[0]!.proxy_target_roas).toBe(3.0)
    expect(out[1]!.proxy_target_roas).toBe(4.0)
    // c-1: marginal_roas 1.0 < 3.0 * 0.7 = 2.1 → critical, far_below
    expect(out[0]!.saturation_level).toBe('critical')
    expect(out[0]!.saturation_reason).toBe('marginal_roas_far_below_proxy_target')
    // c-2: marginal 5.0 > 4.0, elasticity 0.9 > 0.7, low IS, low lost → low
    expect(out[1]!.saturation_level).toBe('low')
  })

  it('marks saturation_level as critical when proxy_target_roas is null/missing', () => {
    const out = addSaturationFeatures([
      {
        campaign_id: 'c-null-proxy',
        proxy_target_roas: null,
        marginal_roas: 1.5,
        elasticity: 0.5,
        impression_share: 0.6,
        lost_is_rank: 0.2,
      },
    ])
    expect(out[0]!.saturation_level).toBe('critical')
    expect(out[0]!.saturation_reason).toBe('missing_marginal_or_proxy_target')
  })

  it('marks saturation_level as critical when marginal_roas is null', () => {
    const out = addSaturationFeatures([
      {
        campaign_id: 'c-null-marg',
        proxy_target_roas: 2.0,
        marginal_roas: null,
        elasticity: 0.5,
        impression_share: 0.6,
        lost_is_rank: 0.2,
      },
    ])
    expect(out[0]!.saturation_level).toBe('critical')
    expect(out[0]!.saturation_reason).toBe('missing_marginal_or_proxy_target')
  })

  it('sets pure_budget_increase_blocked=true when impression_share >= 0.90', () => {
    const out = addSaturationFeatures([
      {
        campaign_id: 'c-blocked',
        proxy_target_roas: 2.0,
        marginal_roas: 2.5,
        elasticity: 0.5,
        impression_share: 0.92,
        lost_is_rank: 0.1,
      },
    ])
    expect(out[0]!.pure_budget_increase_blocked).toBe(true)
    // saturation_level should be 'high' because IS >= 0.9 fires before elasticity check
    expect(out[0]!.saturation_level).toBe('high')
    expect(out[0]!.saturation_reason).toBe('impression_share_above_90pct')
  })

  it('handles missing optional fields safely (no division-by-zero / no throw)', () => {
    // marginal_roas == 0 and proxy_target_roas == 0 → 0 < 0*0.7 is false; not negative; falls through to 'low'
    const out = addSaturationFeatures([
      {
        campaign_id: 'c-zero',
        proxy_target_roas: 0,
        marginal_roas: 0,
        elasticity: null,
        impression_share: null,
        lost_is_rank: null,
      },
    ])
    expect(out[0]!.saturation_level).toBe('low')
    expect(out[0]!.saturation_reason).toBe('room_to_scale')
    expect(out[0]!.pure_budget_increase_blocked).toBe(false)
  })

  it('classifies negative elasticity as critical', () => {
    const [level, reason] = classifySaturation({
      proxy_target_roas: 2.0,
      marginal_roas: 2.5, // not far below
      elasticity: -0.1,
      impression_share: 0.5,
      lost_is_rank: 0.1,
    })
    expect(level).toBe('critical')
    expect(reason).toBe('negative_elasticity')
  })

  it('exposes config defaults from the legacy Python dataclass', () => {
    expect(DEFAULT_SATURATION_CONFIG).toEqual({
      highImpressionShare: 0.90,
      moderateImpressionShare: 0.80,
      highLostIsRank: 0.50,
      criticalMarginalRatio: 0.70,
      highElasticityFloor: 0.35,
      moderateElasticityFloor: 0.70,
    })
  })
})
