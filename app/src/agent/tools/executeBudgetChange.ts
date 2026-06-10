// src/agent/tools/executeBudgetChange.ts
//
// STUB tool: mutates a Google Ads campaign budget via the Google Ads API. The
// real implementation will use GoogleAdsClient and lands in Phase 3.

export interface ExecuteBudgetChangeResult {
  /** Resource name of the mutated budget, e.g. `customers/123/campaignBudgets/456`. */
  resourceName: string
}

export async function executeBudgetChange(
  _customerId: string,
  _budgetResource: string,
  _amountMicros: number,
): Promise<ExecuteBudgetChangeResult> {
  throw new Error('not_implemented_until_phase_3')
}
