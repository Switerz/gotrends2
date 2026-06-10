import { describe, it, expect } from 'vitest'
import { runModel } from '@/agent/tools/runModel'

describe('runModel', () => {
  it('dispatches baselineTrend and returns an array', async () => {
    const out = await runModel('baselineTrend', [])
    expect(Array.isArray(out)).toBe(true)
  })

  it('dispatches anomalyDetection and returns an array', async () => {
    const out = await runModel('anomalyDetection', [])
    expect(Array.isArray(out)).toBe(true)
  })

  it('dispatches confidenceScore and returns an array', async () => {
    const out = await runModel('confidenceScore', [])
    expect(Array.isArray(out)).toBe(true)
  })

  it('dispatches marginalElasticity and returns an array', async () => {
    const out = await runModel('marginalElasticity', [])
    expect(Array.isArray(out)).toBe(true)
  })

  it('dispatches constraintsOptimizer and returns an array', async () => {
    const out = await runModel('constraintsOptimizer', [])
    expect(Array.isArray(out)).toBe(true)
  })

  it('dispatches projectedCos with a single unit case and returns a number', async () => {
    const out = await runModel('projectedCos', {
      current_media_cost: 100,
      current_revenue: 500,
      delta_media_cost: 10,
      expected_incremental_revenue: 30,
    })
    expect(typeof out).toBe('number')
    expect(out).toBeCloseTo(110 / 530, 10)
  })

  it('throws when projectedCos receives an array instead of a unit case', async () => {
    await expect(runModel('projectedCos', [])).rejects.toThrow()
  })

  it('throws on unknown model name', async () => {
    await expect(runModel('does_not_exist', [])).rejects.toThrow(/unknown model/i)
  })

  it('throws when an array-shaped model receives a non-array', async () => {
    await expect(runModel('baselineTrend', { not: 'an array' })).rejects.toThrow()
  })
})
