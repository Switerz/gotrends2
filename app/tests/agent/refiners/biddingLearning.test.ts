// tests/agent/refiners/biddingLearning.test.ts
//
// Pure mapping from raw Google Ads enum strings to the domain type. No DB,
// no candidates — just the classifier table. Catches regressions if Google
// adds new values we silently mishandle.

import { describe, it, expect } from 'vitest'
import {
  BIDDING_LEARNING_LABELS,
  classifyBiddingLearning,
  type BiddingLearningStatus,
} from '@/agent/refiners/biddingLearning'

describe('classifyBiddingLearning', () => {
  it.each([
    ['ENABLED', 'stable'],
    ['enabled', 'stable'], // case-insensitive
  ] as const)('%s → stable', (raw, expected) => {
    expect(classifyBiddingLearning(raw)).toBe<BiddingLearningStatus>(expected)
  })

  it.each([
    'LEARNING_NEW',
    'LEARNING_SETTING_CHANGE',
    'LEARNING_BUDGET_CHANGE',
    'LEARNING_BID_CHANGE',
    'LEARNING_COMPOSITION_CHANGE',
    'LEARNING_CONVERSION_TYPE_CHANGE',
    'LEARNING_CONVERSION_SETTING_CHANGE',
  ])('LEARNING_* family → learning (%s)', (raw) => {
    expect(classifyBiddingLearning(raw)).toBe<BiddingLearningStatus>('learning')
  })

  it.each([
    'LIMITED_BY_CPC_BID_CEILING',
    'LIMITED_BY_CPC_BID_FLOOR',
    'LIMITED_BY_DATA',
    'LIMITED_BY_BUDGET',
    'LIMITED_BY_LOW_PRIORITY_SPEND',
    'LIMITED_BY_LOW_QUALITY',
    'LIMITED_BY_INVENTORY',
    'MISCONFIGURED_ZERO_ELIGIBILITY',
    'MISCONFIGURED_CONVERSION_TYPES',
    'MISCONFIGURED_CONVERSION_VALUES',
    'MISCONFIGURED_SHARED_BUDGET',
    'MISCONFIGURED_STRATEGY_TYPE',
  ])('LIMITED_*/MISCONFIGURED_* family → limited (%s)', (raw) => {
    expect(classifyBiddingLearning(raw)).toBe<BiddingLearningStatus>('limited')
  })

  it.each([
    [null, 'null'],
    [undefined, 'undefined'],
    ['', 'empty string'],
    ['PAUSED', 'PAUSED'],
    ['PENDING', 'PENDING'],
    ['REMOVED', 'REMOVED'],
    ['UNAVAILABLE', 'UNAVAILABLE'],
    ['SOME_FUTURE_VALUE_GOOGLE_INVENTS', 'unrecognised'],
  ] as const)('%s → unknown (%s)', (raw) => {
    expect(classifyBiddingLearning(raw)).toBe<BiddingLearningStatus>('unknown')
  })

  it('has a PT-BR label for every domain value (no surprises in the UI)', () => {
    const expected: BiddingLearningStatus[] = ['stable', 'learning', 'limited', 'unknown']
    for (const v of expected) {
      expect(BIDDING_LEARNING_LABELS[v]).toBeTruthy()
      expect(typeof BIDDING_LEARNING_LABELS[v]).toBe('string')
    }
  })
})
