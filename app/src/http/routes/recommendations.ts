// src/http/routes/recommendations.ts
//
// HTTP surface for the `recommendations` table.
//
//   GET  /api/recommendations               list (filterable by ?status=)
//   GET  /api/recommendations/:id           detail
//   POST /api/recommendations/:id/approve   record an approval (web UI)
//   POST /api/recommendations/:id/reject    record a rejection (web UI)
//
// The POST endpoints are the SPA-driven counterpart of /chat/webhook: cards
// posted via incoming webhook can't carry app-routed button callbacks, so the
// Approve / Reject buttons openLink into the SPA which auto-POSTs here using
// the user's session. /chat/webhook is preserved for future Chat App identity
// work but is no longer load-bearing.
//
// account_label is denormalized in via AccountsRepo so the React client can
// render rows without an extra round trip.

import { Hono, type Context } from 'hono'
import type { Env } from '@/index'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import { AccountsRepo } from '@/db/repos/accounts'
import { ApprovalsRepo } from '@/db/repos/approvals'
import { ChatRepo } from '@/db/repos/chat'
import { toRecommendationDTO } from '@/http/dto/recommendation'
import type { RecommendationStatus } from '@/core/types'
import { requireSession, type SessionVars } from '@/http/middleware'
import { uuid } from '@/lib/uuid'

export const recsRouter = new Hono<{ Bindings: Env; Variables: SessionVars }>()
recsRouter.use('*', requireSession)

// GET /api/recommendations?status=pending&limit=100
recsRouter.get('/', async (c) => {
  const repo = new RecommendationsRepo(c.env.DB)
  const accountsRepo = new AccountsRepo(c.env.DB)
  const status = c.req.query('status') as RecommendationStatus | undefined
  const limitRaw = c.req.query('limit')
  const limit = limitRaw ? Math.max(1, Math.min(500, Number(limitRaw))) : 100

  const rows = status
    ? await repo.listByStatus(status, limit)
    : await repo.listRecent(limit)

  // Denormalize account_label in a single pass over the distinct account ids.
  const accountIds = [...new Set(rows.map((r) => r.account_id))]
  const labelMap = new Map<string, string | null>()
  for (const id of accountIds) {
    const acc = await accountsRepo.get(id)
    labelMap.set(id, acc?.account_label ?? null)
  }
  return c.json(rows.map((r) => toRecommendationDTO(r, labelMap.get(r.account_id))))
})

// GET /api/recommendations/:id
recsRouter.get('/:id', async (c) => {
  const repo = new RecommendationsRepo(c.env.DB)
  const accountsRepo = new AccountsRepo(c.env.DB)
  const row = await repo.getById(c.req.param('id'))
  if (!row) return c.json({ error: 'not_found' }, 404)
  const acc = await accountsRepo.get(row.account_id)
  return c.json(toRecommendationDTO(row, acc?.account_label ?? null))
})

// POST /api/recommendations/:id/approve
recsRouter.post('/:id/approve', (c) => handleDecision(c, 'approve'))

// POST /api/recommendations/:id/reject
recsRouter.post('/:id/reject', (c) => handleDecision(c, 'reject'))

/**
 * Apply an approve/reject decision driven by the SPA. Mirrors the audit-trail
 * write order used by /chat/webhook so dashboards see a uniform schema across
 * both decision channels.
 */
async function handleDecision(
  c: Context<{ Bindings: Env; Variables: SessionVars }>,
  action: 'approve' | 'reject',
) {
  const recsRepo = new RecommendationsRepo(c.env.DB)
  const apvRepo = new ApprovalsRepo(c.env.DB)
  const chatRepo = new ChatRepo(c.env.DB)
  const id = c.req.param('id')
  // Hono's param type is `string | undefined`, but the router pattern guarantees
  // a value here — defend against the impossible case explicitly.
  if (!id) return c.json({ error: 'not_found' }, 404)
  const userEmail = c.get('userEmail')

  const rec = await recsRepo.getById(id)
  if (!rec) return c.json({ error: 'not_found' }, 404)
  if (rec.status !== 'sent_to_chat' && rec.status !== 'pending') {
    return c.json({ error: 'not_pending', currentStatus: rec.status }, 409)
  }

  const decision: 'approved' | 'rejected' =
    action === 'approve' ? 'approved' : 'rejected'

  // Audit: insert approval row first so a partial failure leaves an audit
  // record. `decided_via='web_ui'` distinguishes from google_chat decisions.
  await apvRepo.insert({
    approval_id: uuid(),
    recommendation_id: id,
    account_id: rec.account_id,
    decision,
    decided_by: userEmail,
    decided_via: 'web_ui',
    note: JSON.stringify({ source: 'spa_chat_link' }),
  })

  // Synthetic inbound chat_message so the chat history tab on the SPA shows
  // the decision even though no real Chat webhook fired.
  await chatRepo.insert({
    message_id: uuid(),
    recommendation_id: id,
    account_id: rec.account_id,
    direction: 'inbound',
    space_id: null,
    thread_id: null,
    payload: JSON.stringify({
      source: 'web_ui',
      action,
      decided_by: userEmail,
    }),
  })

  await recsRepo.setStatus(id, decision)

  // Auto-trigger the executor on approval. Best-effort, mirrors /chat/webhook:
  // a failure here leaves the rec in 'approved' state for manual retry rather
  // than rolling back the decision.
  if (decision === 'approved') {
    const executeToken = c.env.EXECUTE_TOKEN
    if (executeToken) {
      try {
        const origin = new URL(c.req.url).origin
        const execRes = await fetch(`${origin}/api/execute/${id}`, {
          method: 'POST',
          headers: { 'x-execute-token': executeToken },
        })
        if (!execRes.ok) {
          console.log(
            JSON.stringify({
              event: 'execute_failed_after_approval',
              recommendationId: id,
              status: execRes.status,
            }),
          )
        }
      } catch (e) {
        console.log(
          JSON.stringify({
            event: 'execute_exception_after_approval',
            recommendationId: id,
            error: (e as Error).message,
          }),
        )
      }
    } else {
      console.log(
        JSON.stringify({
          event: 'execute_skipped_no_token',
          recommendationId: id,
        }),
      )
    }
  }

  return c.json({ ok: true, decision, recommendationId: id })
}
