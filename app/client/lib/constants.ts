// V1 client-side constants. The account picker is hardcoded until we expose
// a /api/accounts endpoint (Phase 7+).

export const DEFAULT_ACCOUNT_ID = '7705857660'

export const ACCOUNTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '7705857660', label: 'Apice' },
]
