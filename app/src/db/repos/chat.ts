// src/db/repos/chat.ts
//
// Repository for the `chat_messages` table. Audit log of every Google Chat
// round-trip tied to a recommendation.

import type { GodeployDB } from '../bootstrap'
import { mapRows } from '../rowMapper'
import type { ChatMessageRow } from '../types'

export class ChatRepo {
  constructor(private readonly db: GodeployDB) {}

  async insert(row: Omit<ChatMessageRow, 'created_at'>): Promise<void> {
    await this.db.exec(
      `INSERT INTO chat_messages (
        message_id, recommendation_id, account_id, space_id, thread_id,
        direction, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        row.message_id,
        row.recommendation_id,
        row.account_id,
        row.space_id,
        row.thread_id,
        row.direction,
        row.payload,
      ],
    )
  }

  async listByRecommendation(
    recommendation_id: string,
  ): Promise<ChatMessageRow[]> {
    const { columns, rows } = await this.db.query(
      `SELECT * FROM chat_messages WHERE recommendation_id = ? ORDER BY created_at`,
      [recommendation_id],
    )
    return mapRows<ChatMessageRow>(columns, rows)
  }
}
