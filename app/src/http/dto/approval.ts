// src/http/dto/approval.ts
//
// HTTP-facing shape for an `approvals` row.
//
// Note: the DB schema (see `ApprovalRow` in `@/db/types`) only stores a small
// identity-blob for the approver (`decided_by` + `decided_via`) plus a free-form
// `note`. The richer "edited budget" / multi-field approver identity in the
// original spec is not in the schema, so this DTO faithfully reflects what
// the DB actually persists. If we extend the schema later (chat user id,
// edited proposal) we add fields here at that time.

import type { ApprovalRow } from '@/db/types'

export interface ApprovalDTO {
  id: string
  recommendationId: string
  accountId: string
  decision: string // 'approved' | 'rejected'
  decidedBy: string | null
  decidedVia: string | null
  decidedAt: string
  note: string | null
}

export function toApprovalDTO(row: ApprovalRow): ApprovalDTO {
  return {
    id: row.approval_id,
    recommendationId: row.recommendation_id,
    accountId: row.account_id,
    decision: row.decision,
    decidedBy: row.decided_by,
    decidedVia: row.decided_via,
    decidedAt: row.decided_at,
    note: row.note,
  }
}
