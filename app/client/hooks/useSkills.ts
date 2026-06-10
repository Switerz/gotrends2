import useSWR from 'swr'
import type { SkillDTO } from '~/lib/types'
import { fetcher } from '~/lib/api'

export function useSkills() {
  return useSWR<SkillDTO[]>('/api/skills', fetcher)
}
