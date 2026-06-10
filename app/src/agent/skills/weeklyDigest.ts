// src/agent/skills/weeklyDigest.ts
//
// Reporting skill (STUB): aggregates weekly performance + recommendation outcomes
// into a markdown digest. The real implementation lands once we have a populated
// decision-outcomes table (see plan task 2.10c / Phase 3).

import type { SkillDescriptor, SkillResult } from './types'

async function run(_input: unknown): Promise<SkillResult> {
  return {
    candidates: [],
    notes:
      'weekly_digest: stub — markdown digest will be generated once execution outcomes are populated.',
  }
}

export const descriptor: SkillDescriptor = {
  key: 'weekly_digest',
  displayName: 'Weekly Digest',
  category: 'reporting',
  description:
    'Aggregate weekly performance and recommendation outcomes into a digest.',
  run,
}
