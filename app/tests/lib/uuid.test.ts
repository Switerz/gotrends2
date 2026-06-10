import { describe, it, expect } from 'vitest'
import { uuid, isUuid, UUID_V4_PATTERN } from '@/lib/uuid'

describe('uuid', () => {
  it('generates a valid UUID v4 string', () => {
    const id = uuid()
    expect(typeof id).toBe('string')
    expect(id.length).toBe(36)
    expect(UUID_V4_PATTERN.test(id)).toBe(true)
  })

  it('generates unique values on subsequent calls', () => {
    const set = new Set<string>()
    for (let i = 0; i < 1000; i++) set.add(uuid())
    expect(set.size).toBe(1000)
  })

  it('isUuid accepts a freshly generated id', () => {
    expect(isUuid(uuid())).toBe(true)
  })

  it('isUuid rejects malformed strings', () => {
    expect(isUuid('not-a-uuid')).toBe(false)
    expect(isUuid('')).toBe(false)
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(false) // version byte 0, not 4
    expect(isUuid('00000000-0000-4000-0000-000000000000')).toBe(false) // variant byte invalid
  })

  it('isUuid accepts canonical lowercase v4', () => {
    expect(isUuid('00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(isUuid('ffffffff-ffff-4fff-bfff-ffffffffffff')).toBe(true)
  })
})
