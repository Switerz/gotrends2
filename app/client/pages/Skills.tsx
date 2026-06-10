import { useSkills } from '~/hooks/useSkills'
import { Card } from '~/components/ui/Card'
import { Spinner } from '~/components/ui/Spinner'
import { EmptyState } from '~/components/ui/EmptyState'
import type { SkillDTO } from '~/lib/types'

type Category = SkillDTO['category']

const CATEGORY_META: Record<Category, { label: string; dot: string }> = {
  diagnostic: { label: 'Diagnostic', dot: 'bg-sage' },
  optimization: { label: 'Optimization', dot: 'bg-amber' },
  reporting: { label: 'Reporting', dot: 'bg-cobalt' },
}

const CATEGORY_ORDER: Category[] = ['diagnostic', 'optimization', 'reporting']

function SkillCard({ skill }: { skill: SkillDTO }) {
  return (
    <Card hover className="cursor-default">
      <div className="px-5 py-4">
        <div className="font-display text-lg text-ink-100 mb-1">{skill.displayName}</div>
        <p className="text-sm text-ink-300 leading-relaxed">{skill.description}</p>
        <div className="font-mono text-[11px] text-ink-400 mt-3">{skill.key}</div>
      </div>
    </Card>
  )
}

export default function Skills() {
  const { data, error, isLoading } = useSkills()

  const grouped: Record<Category, SkillDTO[]> = {
    diagnostic: [],
    optimization: [],
    reporting: [],
  }
  for (const s of data ?? []) {
    if (s.category in grouped) grouped[s.category].push(s)
  }

  return (
    <div className="px-2 md:px-0 py-2">
      <h1 className="font-display text-4xl mb-1">Skills</h1>
      <p className="text-ink-300 mb-8">
        Catálogo de capacidades do agente, agrupadas por tipo.
      </p>

      {error && (
        <div className="mb-6 hairline rounded-card bg-coral-wash/40 px-5 py-4 text-sm text-coral">
          Falha ao carregar skills: {String(error.message ?? error)}
        </div>
      )}

      {isLoading ? (
        <div className="py-16 flex justify-center">
          <Spinner />
        </div>
      ) : (data ?? []).length === 0 ? (
        <EmptyState
          title="Sem skills"
          description="O catálogo de skills está vazio."
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {CATEGORY_ORDER.map((cat) => {
            const meta = CATEGORY_META[cat]
            const skills = grouped[cat]
            return (
              <div key={cat}>
                <div className="flex items-center gap-2 mb-4">
                  <span className={`size-2 rounded-full ${meta.dot}`} />
                  <span className="text-[11px] uppercase tracking-[0.12em] font-mono text-ink-300">
                    {meta.label}
                  </span>
                  <span className="font-mono tabular-nums text-[11px] text-ink-500 ml-1">
                    {skills.length}
                  </span>
                </div>
                <div className="flex flex-col gap-3">
                  {skills.length === 0 ? (
                    <div className="hairline rounded-card bg-ink-800/40 px-5 py-4 text-sm text-ink-400 italic">
                      Sem skills nesta categoria.
                    </div>
                  ) : (
                    skills.map((s) => <SkillCard key={s.key} skill={s} />)
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
