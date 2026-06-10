// src/http/routes/chatWebhook.ts
//
// Google Chat interactive webhook. Google Chat POSTs to this endpoint when a
// user clicks an Approve / Reject button on a recommendation card.
//
// Responsibilities:
//  - lightweight verification token auth (opt-in: enforced only when the env
//    var is set; absent in dev means traffic is allowed through)
//  - parse the interaction event via @/clients/googleChat#parseInteractionEvent
//  - load the recommendation, verify it is in an actionable state
//  - write the audit trail: chat_messages (inbound) + approvals
//  - update recommendations.status to approved / rejected
//  - respond with a card-replacing message (actionResponse: UPDATE_MESSAGE)
//
// Refiner gate already ran prior to the card being sent; this route only flips
// status after a human decision and is therefore safe to be the *only* writer
// of the approved/rejected transition.

import { Hono } from 'hono'
import type { Env } from '@/index'
import { parseInteractionEvent } from '@/clients/googleChat'
import { RecommendationsRepo } from '@/db/repos/recommendations'
import { ApprovalsRepo } from '@/db/repos/approvals'
import { ChatRepo } from '@/db/repos/chat'
import { uuid } from '@/lib/uuid'

export const chatWebhookRouter = new Hono<{ Bindings: Env }>()

/** POST /chat/webhook — invoked by Google Chat on button click. */
chatWebhookRouter.post('/webhook', async (c) => {
  // Lightweight auth: Google Chat is configured with a verification token at
  // bot registration time. Fails closed by default: if the env var is unset we
  // return 500 server_misconfigured unless the explicit dev opt-in
  // `ALLOW_UNAUTHENTICATED_CHAT=1` is set. When the env var IS set we require
  // the request to carry it either via Authorization: Bearer <token> or ?token=.
  const expected = c.env.GOOGLE_CHAT_VERIFICATION_TOKEN
  const allowUnauth = c.env.ALLOW_UNAUTHENTICATED_CHAT === '1'
  if (!expected) {
    if (!allowUnauth) {
      return c.json(
        {
          error: 'server_misconfigured',
          detail: 'GOOGLE_CHAT_VERIFICATION_TOKEN not set',
        },
        500,
      )
    }
    // explicit dev opt-in: accept without verification
  } else {
    const authHeader = c.req.header('authorization') ?? ''
    const bearer = authHeader.replace(/^Bearer\s+/i, '')
    const queryTok = c.req.query('token') ?? ''
    const token = bearer || queryTok
    if (token !== expected) {
      return c.json({ error: 'unauthorized' }, 401)
    }
  }

  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    return c.json({ error: 'invalid_json' }, 400)
  }

  let event
  try {
    event = parseInteractionEvent(payload)
  } catch (e) {
    return c.json({ error: 'invalid_event', detail: (e as Error).message }, 400)
  }

  const recsRepo = new RecommendationsRepo(c.env.DB)
  const apvRepo = new ApprovalsRepo(c.env.DB)
  const chatRepo = new ChatRepo(c.env.DB)

  // Verify recommendation exists + is actionable.
  const rec = await recsRepo.getById(event.recommendationId)
  if (!rec) return c.json({ error: 'recommendation_not_found' }, 404)
  if (rec.status !== 'sent_to_chat' && rec.status !== 'pending') {
    return c.json(
      { error: 'recommendation_not_pending', currentStatus: rec.status },
      409,
    )
  }

  // Log inbound chat message (audit trail).
  await chatRepo.insert({
    message_id: uuid(),
    recommendation_id: event.recommendationId,
    account_id: rec.account_id,
    space_id: event.spaceId,
    thread_id: null,
    direction: 'inbound',
    payload: JSON.stringify(payload),
  })

  // Write the approval. The schema has no dedicated columns for chat user id /
  // display name / chat message id, so we pack that metadata as JSON into the
  // free-form `note` column. The Insider-facing UI can deserialize it later.
  const decision = event.action === 'approve' ? 'approved' : 'rejected'
  const approverMetaJson = JSON.stringify({
    displayName: event.user.displayName,
    chatUserId: event.user.chatUserId,
    chatMessageName: event.messageName,
  })
  await apvRepo.insert({
    approval_id: uuid(),
    recommendation_id: event.recommendationId,
    account_id: rec.account_id,
    decision,
    decided_by: event.user.email ?? event.user.chatUserId ?? 'unknown',
    decided_via: 'google_chat',
    note: approverMetaJson,
  })

  // Update recommendation status. Maps directly onto the workflow vocabulary.
  const newStatus = decision === 'approved' ? 'approved' : 'rejected'
  await recsRepo.setStatus(event.recommendationId, newStatus)

  // Respond with a card-replacing message; Google Chat clients render this
  // immediately in place of the original card.
  const who =
    event.user.displayName || event.user.email || 'um membro do espaço'
  return c.json({
    actionResponse: { type: 'UPDATE_MESSAGE' },
    text:
      decision === 'approved'
        ? `Aprovado por ${who}`
        : `Rejeitado por ${who}`,
  })
})
