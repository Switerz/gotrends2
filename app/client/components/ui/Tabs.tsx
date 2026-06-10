import { type ReactNode, useState } from 'react'
import clsx from 'clsx'

interface Tab {
  key: string
  label: string
  content: ReactNode
}

export function Tabs({ tabs, initial }: { tabs: Tab[]; initial?: string }) {
  const first = tabs[0]?.key ?? ''
  const [active, setActive] = useState<string>(initial ?? first)
  const activeTab = tabs.find((t) => t.key === active)
  return (
    <div>
      <div className="flex gap-1 hairline-b">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActive(t.key)}
            className={clsx(
              'px-4 py-3 text-sm font-medium transition-colors duration-200 ease-editorial relative -mb-px',
              active === t.key
                ? 'text-ink-100 border-b-2 border-sage'
                : 'text-ink-300 hover:text-ink-100 border-b-2 border-transparent',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="py-6">{activeTab?.content}</div>
    </div>
  )
}
