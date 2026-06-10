/** Generate a UUID v4 string using Web Crypto API (available in Cloudflare Workers + Node 19+). */
export function uuid(): string {
  return crypto.randomUUID()
}

/** UUID v4 regex pattern — accepts canonical lowercase format. */
export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** Predicate: is the given string a UUID v4? */
export function isUuid(s: string): boolean {
  return UUID_V4_PATTERN.test(s)
}
