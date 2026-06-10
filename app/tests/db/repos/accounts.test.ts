// tests/db/repos/accounts.test.ts

import { describe, it, expect } from 'vitest'
import { AccountsRepo } from '@/db/repos/accounts'
import type { AccountRow } from '@/db/types'
import { makeFakeDb } from './_fakeDb'

function seedAccount(
  fake: ReturnType<typeof makeFakeDb>,
  overrides: Partial<AccountRow> = {},
): AccountRow {
  const row: AccountRow = {
    account_id: 'acc-1',
    account_label: 'Apice',
    company: 'Apice / GoGroup',
    login_customer_id: null,
    default_chat_space_id: null,
    default_approver_emails: null,
    is_active: 1,
    created_at: '2026-06-10 00:00:00',
    updated_at: '2026-06-10 00:00:00',
    ...overrides,
  }
  const arr = fake.tables.get('accounts') ?? []
  arr.push(row as unknown as Record<string, unknown>)
  fake.tables.set('accounts', arr)
  return row
}

describe('AccountsRepo', () => {
  it('get returns the seeded account', async () => {
    const db = makeFakeDb()
    seedAccount(db, { account_id: 'a-1', account_label: 'One' })
    const repo = new AccountsRepo(db)
    const got = await repo.get('a-1')
    expect(got?.account_id).toBe('a-1')
    expect(got?.account_label).toBe('One')
  })

  it('get returns null when account is missing', async () => {
    const db = makeFakeDb()
    const repo = new AccountsRepo(db)
    const got = await repo.get('nope')
    expect(got).toBeNull()
  })

  it('listActive only returns rows with is_active = 1', async () => {
    const db = makeFakeDb()
    seedAccount(db, { account_id: 'a-1', is_active: 1 })
    seedAccount(db, { account_id: 'a-2', is_active: 0 })
    seedAccount(db, { account_id: 'a-3', is_active: 1 })
    const repo = new AccountsRepo(db)
    const got = await repo.listActive()
    expect(got.map((r) => r.account_id).sort()).toEqual(['a-1', 'a-3'])
  })

  it('listActive returns [] when no accounts exist', async () => {
    const db = makeFakeDb()
    const repo = new AccountsRepo(db)
    expect(await repo.listActive()).toEqual([])
  })

  it('preserves null fields on read', async () => {
    const db = makeFakeDb()
    seedAccount(db, { account_id: 'a-1', company: null, login_customer_id: null })
    const repo = new AccountsRepo(db)
    const got = await repo.get('a-1')
    expect(got?.company).toBeNull()
    expect(got?.login_customer_id).toBeNull()
  })
})
