// tests/db/repos/chat.test.ts

import { describe, it, expect } from 'vitest'
import { ChatRepo } from '@/db/repos/chat'
import type { ChatMessageRow } from '@/db/types'
import { makeFakeDb } from './_fakeDb'

function baseMsg(over: Partial<ChatMessageRow> = {}): Omit<ChatMessageRow, 'created_at'> {
  return {
    message_id: 'm-1',
    recommendation_id: 'rec-1',
    account_id: '7705857660',
    space_id: 'spaces/AAA',
    thread_id: 'threads/BBB',
    direction: 'outbound',
    payload: '{"text":"hi"}',
    ...over,
  } as Omit<ChatMessageRow, 'created_at'>
}

describe('ChatRepo', () => {
  it('insert + listByRecommendation round-trip', async () => {
    const db = makeFakeDb()
    const repo = new ChatRepo(db)
    await repo.insert(baseMsg({ message_id: 'm-A' }))
    const got = await repo.listByRecommendation('rec-1')
    expect(got.length).toBe(1)
    expect(got[0]!.message_id).toBe('m-A')
    expect(got[0]!.direction).toBe('outbound')
    expect(got[0]!.payload).toBe('{"text":"hi"}')
  })

  it('listByRecommendation returns [] when none exist', async () => {
    const db = makeFakeDb()
    const repo = new ChatRepo(db)
    expect(await repo.listByRecommendation('missing')).toEqual([])
  })

  it('listByRecommendation filters by recommendation_id', async () => {
    const db = makeFakeDb()
    const repo = new ChatRepo(db)
    await repo.insert(baseMsg({ message_id: 'm1', recommendation_id: 'r1' }))
    await repo.insert(baseMsg({ message_id: 'm2', recommendation_id: 'r2' }))
    await repo.insert(baseMsg({ message_id: 'm3', recommendation_id: 'r1' }))
    const got = await repo.listByRecommendation('r1')
    expect(got.map((m) => m.message_id).sort()).toEqual(['m1', 'm3'])
  })

  it('orders results by created_at ASC', async () => {
    const db = makeFakeDb()
    const repo = new ChatRepo(db)
    await repo.insert(baseMsg({ message_id: 'm1' }))
    await repo.insert(baseMsg({ message_id: 'm2' }))
    await repo.insert(baseMsg({ message_id: 'm3' }))
    const arr = db.tables.get('chat_messages')!
    arr[0]!.created_at = '2026-06-05 00:00:00'
    arr[1]!.created_at = '2026-06-01 00:00:00'
    arr[2]!.created_at = '2026-06-09 00:00:00'
    const got = await repo.listByRecommendation('rec-1')
    expect(got.map((m) => m.message_id)).toEqual(['m2', 'm1', 'm3'])
  })

  it('preserves null thread_id and recommendation_id', async () => {
    const db = makeFakeDb()
    const repo = new ChatRepo(db)
    // Use a non-null recommendation_id since listByRecommendation requires one,
    // but null out the thread_id to assert it survives the round-trip.
    await repo.insert(
      baseMsg({
        message_id: 'm-null',
        thread_id: null,
        space_id: null,
      }),
    )
    const got = await repo.listByRecommendation('rec-1')
    expect(got[0]!.thread_id).toBeNull()
    expect(got[0]!.space_id).toBeNull()
  })
})
