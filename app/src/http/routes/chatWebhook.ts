// src/http/routes/chatWebhook.ts
//
// Google Chat interactive webhook. Google Chat POSTs to this endpoint when a
// user clicks an Approve / Reject button on a recommendation card.
//
// Auth: every Chat request is signed with an RS256 JWT issued by
// `chat@system.gserviceaccount.com`, audience `<APP_ORIGIN>/chat/webhook`.
// Verification happens in `requireChatJwt` (applied below as router-level
// middleware); the handler can assume the caller is Google Chat.
//
// Responsibilities:
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
import { requireChatJwt } from '@/http/middleware'

export const chatWebhookRouter = new Hono<{ Bindings: Env }>()
chatWebhookRouter.use('*', requireChatJwt)

/** POST /chat/webhook — invoked by Google Chat on button click. */
chatWebhookRouter.post('/webhook', async (c) => {
  let payload: unknown
  try {
    payload = await c.req.json()
  } catch {
    console.log(JSON.stringify({ event: 'chat_webhook_invalid_json' }))
    return c.json({ error: 'invalid_json' }, 400)
  }

  // Debug log the inbound payload shape (truncated for safety)
  try {
    const stringified = JSON.stringify(payload)
    console.log(JSON.stringify({
      event: 'chat_webhook_payload',
      payloadPreview: stringified.slice(0, 1500),
      payloadLength: stringified.length,
    }))
  } catch {
    /* ignore */
  }

  let event
  try {
    event = parseInteractionEvent(payload)
  } catch (e) {
    console.log(JSON.stringify({
      event: 'chat_webhook_parse_failed',
      error: (e as Error).message,
      payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload as object) : null,
    }))
    return c.json({ error: 'invalid_event', detail: (e as Error).message }, 400)
  }
  console.log(JSON.stringify({
    event: 'chat_webhook_parsed',
    recommendationId: event.recommendationId,
    action: event.action,
    userEmail: event.user.email,
  }))

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

  // Auto-trigger the executor on approval. Best-effort: never throw out of the
  // webhook because of an execute failure — the recommendation stays in the
  // 'approved' state and operators can retry via POST /api/execute/:id.
  if (decision === 'approved') {
    const execToken = c.env.EXECUTE_TOKEN
    if (execToken) {
      try {
        const origin = new URL(c.req.url).origin
        const execRes = await fetch(`${origin}/api/execute/${event.recommendationId}`, {
          method: 'POST',
          headers: { 'x-execute-token': execToken },
        })
        if (!execRes.ok) {
          console.log(
            JSON.stringify({
              event: 'execute_failed_after_approval',
              recommendationId: event.recommendationId,
              status: execRes.status,
            }),
          )
        }
      } catch (e) {
        console.log(
          JSON.stringify({
            event: 'execute_exception_after_approval',
            recommendationId: event.recommendationId,
            error: (e as Error).message,
          }),
        )
      }
    } else {
      console.log(
        JSON.stringify({
          event: 'execute_skipped_no_token',
          recommendationId: event.recommendationId,
        }),
      )
    }
  }

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
