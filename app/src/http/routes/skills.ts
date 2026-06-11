// src/http/routes/skills.ts
//
// Read-only catalog of Skills (Ryze-style high-level capabilities). The shape
// is intentionally trimmed: we only return the descriptor metadata, never the
// `run()` function reference (would not be JSON-serializable anyway, but we
// also do not want clients to discover the executor surface this way).

import { Hono } from 'hono'
import type { Env } from '@/index'
import { SKILLS } from '@/agent/skills/registry'
import { requireSession } from '@/http/middleware'

export const skillsRouter = new Hono<{ Bindings: Env }>()
skillsRouter.use('*', requireSession)

// GET /api/skills
skillsRouter.get('/', (c) => {
  return c.json(
    SKILLS.map((s) => ({
      key: s.key,
      displayName: s.displayName,
      category: s.category,
      description: s.description,
    })),
  )
})
