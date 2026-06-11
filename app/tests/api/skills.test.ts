// tests/api/skills.test.ts
//
// /api/skills returns the registered Skills catalog. The route must NOT leak
// the `run()` function reference (it would not be JSON-serializable, but we
// also do not want clients to discover the executor surface via the catalog).

import { describe, it, expect, beforeEach } from 'vitest'
import worker, { _resetBootstrapForTests, type Env } from '@/index'
import { SKILLS } from '@/agent/skills/registry'
import { TEST_SESSION_SECRET, makeSessionCookie } from '../auth/_helpers'

function makeEnv(): Env {
  return {
    DB: {
      async exec() {
        return { rowsWritten: 0 }
      },
      async query() {
        return { columns: [], rows: [], rowsRead: 0 }
      },
    },
    SESSION_SECRET: TEST_SESSION_SECRET,
  } as Env
}

async function authedFetch(env: Env, url: string): Promise<Response> {
  const cookie = await makeSessionCookie()
  return worker.fetch(
    new Request(url, { headers: { cookie } }),
    env,
    {} as ExecutionContext,
  )
}

describe('GET /api/skills', () => {
  beforeEach(() => _resetBootstrapForTests())

  it('returns 401 when no session cookie is present', async () => {
    const res = await worker.fetch(
      new Request('http://x/api/skills'),
      makeEnv(),
      {} as ExecutionContext,
    )
    expect(res.status).toBe(401)
  })

  it('returns every registered skill with category metadata', async () => {
    const res = await authedFetch(makeEnv(), 'http://x/api/skills')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<{ key: string; category: string }>
    expect(body).toHaveLength(SKILLS.length)
    expect(body.map((s) => s.key).sort()).toEqual([...SKILLS.map((s) => s.key)].sort())
    for (const s of body) {
      expect(typeof s.category).toBe('string')
      expect(['diagnostic', 'optimization', 'reporting']).toContain(s.category)
    }
  })

  it('exposes only key/displayName/category/description (no run function)', async () => {
    const res = await authedFetch(makeEnv(), 'http://x/api/skills')
    const body = (await res.json()) as Array<Record<string, unknown>>
    for (const s of body) {
      expect(Object.keys(s).sort()).toEqual(['category', 'description', 'displayName', 'key'])
    }
  })
})
