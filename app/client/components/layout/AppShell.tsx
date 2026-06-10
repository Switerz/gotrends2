import { NavLink, Outlet, useLocation } from 'react-router-dom'
import clsx from 'clsx'
import {
  DashboardIcon,
  RecommendationsIcon,
  RunsIcon,
  CampaignsIcon,
  SkillsIcon,
  DigestIcon,
} from '../icons'

type NavItem = {
  to: string
  label: string
  Icon: (props: { className?: string }) => JSX.Element
  end?: boolean
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', Icon: DashboardIcon, end: true },
  { to: '/recommendations', label: 'Recomendações', Icon: RecommendationsIcon },
  { to: '/runs', label: 'Runs', Icon: RunsIcon },
  { to: '/campaigns', label: 'Campanhas', Icon: CampaignsIcon },
  { to: '/skills', label: 'Skills', Icon: SkillsIcon },
  { to: '/digest', label: 'Digest', Icon: DigestIcon },
]

function Sidebar() {
  return (
    <aside className="hidden md:flex md:flex-col md:w-[220px] md:shrink-0 bg-ink-800 hairline-b md:hairline-b-0 md:border-r md:border-ink-600 md:h-screen md:sticky md:top-0 z-10">
      <div className="px-5 py-5 hairline-b">
        <div className="flex items-baseline gap-1">
          <span className="font-display text-xl font-medium text-ink-100 tracking-tight">GoTrends</span>
          <sup className="font-mono text-[10px] text-ink-300">v2</sup>
        </div>
        <div className="mt-1 text-[10px] uppercase tracking-[0.12em] font-mono text-ink-400">
          Campaign Intelligence
        </div>
      </div>
      <nav className="py-4 flex flex-col gap-0.5">
        {NAV.map(({ to, label, Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              clsx(
                'group relative flex items-center gap-3 mx-2 px-3 py-2 rounded-card text-sm transition-all duration-200 ease-editorial',
                'border-l-2',
                isActive
                  ? 'bg-ink-700 text-ink-100 border-sage'
                  : 'text-ink-300 border-transparent hover:text-ink-100 hover:translate-x-0.5 hover:border-sage/40',
              )
            }
          >
            <Icon className="shrink-0" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto px-5 py-4 hairline-t">
        <div className="text-[10px] uppercase tracking-[0.12em] font-mono text-ink-400">
          Editorial Build
        </div>
      </div>
    </aside>
  )
}

function envInfo(): { label: string; tone: 'sage' | 'amber' | 'neutral' } {
  const mode =
    typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env.MODE : 'dev'
  if (mode === 'production') return { label: 'prod', tone: 'sage' }
  if (mode === 'development') return { label: 'dev', tone: 'amber' }
  return { label: mode ?? 'unknown', tone: 'neutral' }
}

function Breadcrumb() {
  const { pathname } = useLocation()
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length === 0) {
    return <span className="font-mono text-xs text-ink-300 uppercase tracking-[0.12em]">Dashboard</span>
  }
  return (
    <nav className="flex items-center gap-2 text-xs font-mono uppercase tracking-[0.12em]">
      <span className="text-ink-400">/</span>
      {segments.map((seg, i) => (
        <span key={`${seg}-${i}`} className={i === segments.length - 1 ? 'text-ink-100' : 'text-ink-400'}>
          {seg}
          {i < segments.length - 1 && <span className="ml-2 text-ink-500">/</span>}
        </span>
      ))}
    </nav>
  )
}

function Topbar() {
  const env = envInfo()
  const toneClass =
    env.tone === 'sage'
      ? 'text-sage bg-sage-wash border-sage-dim/40'
      : env.tone === 'amber'
        ? 'text-amber bg-amber-wash border-amber-dim/40'
        : 'text-ink-200 bg-ink-700 border-ink-500'
  return (
    <header className="h-14 hairline-b bg-ink-900/80 backdrop-blur-sm sticky top-0 z-20">
      <div className="h-full flex items-center justify-between px-6 md:px-8">
        <Breadcrumb />
        <div className="flex items-center gap-3">
          <span
            className={clsx(
              'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-pill border text-[10px] uppercase tracking-[0.08em] font-mono font-medium',
              toneClass,
            )}
          >
            <span className="size-1.5 rounded-full bg-current opacity-80" />
            {env.label}
          </span>
        </div>
      </div>
    </header>
  )
}

export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 max-w-7xl w-full mx-auto px-6 md:px-8 py-6 animate-fade-up relative z-[2]">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
