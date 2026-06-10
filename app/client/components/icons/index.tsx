import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Base({ children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={18}
      height={18}
      viewBox="0 0 18 18"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function DashboardIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.5" y="2.5" width="13" height="3" rx="0.5" />
      <rect x="2.5" y="7.5" width="13" height="3" rx="0.5" />
      <rect x="2.5" y="12.5" width="13" height="3" rx="0.5" />
    </Base>
  )
}

export function RecommendationsIcon(props: IconProps) {
  return (
    <Base {...props}>
      <path d="M6 11.5a4 4 0 1 1 6 0c-.5.4-1 1-1 1.7v.3H7v-.3c0-.7-.5-1.3-1-1.7Z" />
      <path d="M7.5 15.5h3" />
      <path d="M8 17h2" />
    </Base>
  )
}

export function RunsIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="9" cy="9" r="6.5" />
      <path d="M7.5 6.5 12 9l-4.5 2.5Z" />
    </Base>
  )
}

export function CampaignsIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="9" cy="9" r="6.5" />
      <circle cx="9" cy="9" r="3.5" />
      <circle cx="9" cy="9" r="0.5" fill="currentColor" />
    </Base>
  )
}

export function SkillsIcon(props: IconProps) {
  return (
    <Base {...props}>
      <circle cx="4.5" cy="9" r="1.25" />
      <circle cx="9" cy="9" r="1.25" />
      <circle cx="13.5" cy="9" r="1.25" />
    </Base>
  )
}

export function DigestIcon(props: IconProps) {
  return (
    <Base {...props}>
      <rect x="2.5" y="3.5" width="13" height="11" rx="1" />
      <path d="M5 6.5h8" />
      <path d="M5 9h8" />
      <path d="M5 11.5h5" />
    </Base>
  )
}
