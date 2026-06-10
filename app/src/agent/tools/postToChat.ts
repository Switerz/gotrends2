// src/agent/tools/postToChat.ts
//
// STUB tool: posts a message to a Google Chat space. The real implementation
// will use GoogleChatClient and lands in Phase 3 of the migration plan.
//
// Signature is final so callers can wire against it today.

/** Outbound Google Chat message envelope. The shape mirrors the Chat API. */
export interface PostToChatResult {
  /** Server-assigned resource name, e.g. `spaces/AAAA.../messages/XYZ`. */
  name: string
}

export async function postToChat(
  _webhookUrl: string,
  _body: unknown,
): Promise<PostToChatResult> {
  throw new Error('not_implemented_until_phase_3')
}
