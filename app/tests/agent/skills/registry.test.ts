import { describe, it, expect } from 'vitest'
import { SKILLS, findSkill } from '@/agent/skills/registry'

describe('skills registry', () => {
  it('exposes exactly 10 skills', () => {
    expect(SKILLS.length).toBe(10)
  })

  it('covers all 3 categories', () => {
    const cats = new Set(SKILLS.map(s => s.category))
    expect(cats).toEqual(new Set(['diagnostic', 'optimization', 'reporting']))
  })

  it('has 4 diagnostic, 3 optimization, 3 reporting skills', () => {
    const byCat: Record<string, number> = {}
    for (const s of SKILLS) {
      byCat[s.category] = (byCat[s.category] ?? 0) + 1
    }
    expect(byCat).toEqual({ diagnostic: 4, optimization: 3, reporting: 3 })
  })

  it('skill keys are unique', () => {
    const keys = SKILLS.map(s => s.key)
    expect(new Set(keys).size).toBe(10)
  })

  it('findSkill resolves a known key', () => {
    expect(findSkill('budget_reallocation')?.displayName).toMatch(/budget/i)
  })

  it('findSkill returns undefined for unknown key', () => {
    expect(findSkill('missing_xyz')).toBeUndefined()
  })

  it('all 10 skill keys match the seeded keys in db/schema', async () => {
    const { SEED_SKILLS } = await import('@/db/schema')
    const seedKeys = new Set(SEED_SKILLS.map(s => s.skill_key))
    const registryKeys = new Set(SKILLS.map(s => s.key))
    expect(registryKeys).toEqual(seedKeys)
  })

  it('each skill has a non-empty displayName and description', () => {
    for (const s of SKILLS) {
      expect(s.displayName.length).toBeGreaterThan(0)
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it('each skill exposes a run function', () => {
    for (const s of SKILLS) {
      expect(typeof s.run).toBe('function')
    }
  })

  it('stub skills return a SkillResult with notes', async () => {
    const weekly = findSkill('weekly_digest')!
    const ctx = { db: {} as never }
    const result = await weekly.run({}, ctx)
    expect(result.candidates).toEqual([])
    expect(result.notes).toMatch(/stub/i)
  })
})
