// tests/db/repos/campaignRevenue.test.ts

import { describe, it, expect } from 'vitest'
import { CampaignRevenueRepo } from '@/db/repos/campaignRevenue'
import { makeFakeDb } from './_fakeDb'

describe('CampaignRevenueRepo', () => {
  it('upsert + listByAccountAndDateRange round-trip', async () => {
    const db = makeFakeDb()
    const repo = new CampaignRevenueRepo(db)
    await repo.upsert({
      account_id: 'acc-1',
      campaign_name: 'pesquisa-institucional',
      date: '2026-06-10',
      provider: 'yampi',
      revenue_brl: 80.50,
      n_orders: 3,
    })
    const rows = await repo.listByAccountAndDateRange('acc-1', '2026-06-10', '2026-06-10')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.revenue_brl).toBe(80.50)
    expect(rows[0]?.n_orders).toBe(3)
    expect(rows[0]?.provider).toBe('yampi')
  })

  it('upsert overwrites the existing row for the same (account, campaign, date)', async () => {
    const db = makeFakeDb()
    const repo = new CampaignRevenueRepo(db)
    const base = {
      account_id: 'acc-1',
      campaign_name: 'pesquisa-institucional',
      date: '2026-06-10',
      provider: 'yampi',
      n_orders: 1,
    }
    await repo.upsert({ ...base, revenue_brl: 100 })
    await repo.upsert({ ...base, revenue_brl: 250, n_orders: 5 })
    const rows = await repo.listByAccountAndDateRange('acc-1', '2026-06-10', '2026-06-10')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.revenue_brl).toBe(250)
    expect(rows[0]?.n_orders).toBe(5)
  })

  it('listByAccountAndDateRange filters by date window', async () => {
    const db = makeFakeDb()
    const repo = new CampaignRevenueRepo(db)
    for (const date of ['2026-06-05', '2026-06-10', '2026-06-15']) {
      await repo.upsert({
        account_id: 'acc-1',
        campaign_name: 'X',
        date,
        provider: 'yampi',
        revenue_brl: 10,
        n_orders: 1,
      })
    }
    const got = await repo.listByAccountAndDateRange('acc-1', '2026-06-08', '2026-06-12')
    expect(got.map((r) => r.date)).toEqual(['2026-06-10'])
  })

  it('listByAccountAndDateRange is scoped to account_id', async () => {
    const db = makeFakeDb()
    const repo = new CampaignRevenueRepo(db)
    for (const acc of ['acc-A', 'acc-B']) {
      await repo.upsert({
        account_id: acc,
        campaign_name: 'X',
        date: '2026-06-10',
        provider: 'yampi',
        revenue_brl: 10,
        n_orders: 1,
      })
    }
    const got = await repo.listByAccountAndDateRange('acc-A', '2026-06-10', '2026-06-10')
    expect(got).toHaveLength(1)
    expect(got[0]?.account_id).toBe('acc-A')
  })

  it('upsertMany loops through the array', async () => {
    const db = makeFakeDb()
    const repo = new CampaignRevenueRepo(db)
    await repo.upsertMany([
      { account_id: 'acc-1', campaign_name: 'a', date: '2026-06-10', provider: 'yampi', revenue_brl: 1, n_orders: 1 },
      { account_id: 'acc-1', campaign_name: 'b', date: '2026-06-10', provider: 'yampi', revenue_brl: 2, n_orders: 1 },
      { account_id: 'acc-1', campaign_name: 'c', date: '2026-06-10', provider: 'yampi', revenue_brl: 3, n_orders: 1 },
    ])
    const got = await repo.listByAccountAndDateRange('acc-1', '2026-06-10', '2026-06-10')
    expect(got).toHaveLength(3)
  })
})
