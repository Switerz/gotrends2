// src/agent/skills/decisionBacktest.ts
//
// Reporting skill (STUB): backtests past recommendations against realized metrics.
// Requires the decision-log + execution_outcomes plumbing which lands in Phase 3.

import type { SkillDescriptor, SkillResult } from './types'

async function run(_input: unknown): Promise<SkillResult> {
  return {
    candidates: [],
    notes:
      'decision_backtest: stub — implementation pending the decision log (Phase 3, see plan).',
  }
}

export const descriptor: SkillDescriptor = {
  key: 'decision_backtest',
  displayName: 'Decision Backtest',
  category: 'reporting',
  description: 'Backtest past recommendations against realized metrics.',
  run,
}
