type IconProps = {
  size?: number
  strokeWidth?: number
}

const common = {
  fill: 'none',
  stroke: 'currentColor',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

export function GridIcon({ size = 14, strokeWidth = 1.6 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...common} strokeWidth={strokeWidth}>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="2" width="5" height="5" rx="1" />
      <rect x="2" y="9" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" />
    </svg>
  )
}

export function ListIcon({ size = 14, strokeWidth = 1.6 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...common} strokeWidth={strokeWidth}>
      <line x1="3" y1="4" x2="13" y2="4" />
      <line x1="3" y1="8" x2="13" y2="8" />
      <line x1="3" y1="12" x2="13" y2="12" />
    </svg>
  )
}

export function SettingsIcon({ size = 16, strokeWidth = 1.6 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...common} strokeWidth={strokeWidth}>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.5M8 12.7v1.5M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M1.8 8h1.5M12.7 8h1.5M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </svg>
  )
}

export function HelpCircleIcon({ size = 16, strokeWidth = 1.6 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...common} strokeWidth={strokeWidth}>
      <circle cx="8" cy="8" r="6" />
      <path d="M6.4 6.2A1.8 1.8 0 0 1 8 5.2c1.1 0 1.9.7 1.9 1.7 0 .8-.4 1.2-1.1 1.6-.5.3-.8.6-.8 1.3" />
      <line x1="8" y1="12" x2="8" y2="12.1" />
    </svg>
  )
}

export function XIcon({ size = 16, strokeWidth = 1.8 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...common} strokeWidth={strokeWidth}>
      <line x1="4" y1="4" x2="12" y2="12" />
      <line x1="12" y1="4" x2="4" y2="12" />
    </svg>
  )
}

export function PencilIcon({ size = 14, strokeWidth = 1.6 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...common} strokeWidth={strokeWidth}>
      <path d="M10.8 2.8l2.4 2.4-7 7-3.1.7.7-3.1 7-7z" />
      <line x1="9.6" y1="4" x2="12" y2="6.4" />
    </svg>
  )
}

export function PlusIcon({ size = 14, strokeWidth = 1.8 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...common} strokeWidth={strokeWidth}>
      <line x1="8" y1="3" x2="8" y2="13" />
      <line x1="3" y1="8" x2="13" y2="8" />
    </svg>
  )
}

export function FolderIcon({ size = 13, strokeWidth = 1.6 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...common} strokeWidth={strokeWidth}>
      <path d="M2 4.2c0-.7.6-1.3 1.3-1.3h2.8l1.3 1.6h5.3c.7 0 1.3.6 1.3 1.3v5.4c0 .7-.6 1.3-1.3 1.3H3.3c-.7 0-1.3-.6-1.3-1.3V4.2z" />
    </svg>
  )
}

export function ExternalLinkIcon({ size = 13, strokeWidth = 1.6 }: IconProps): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...common} strokeWidth={strokeWidth}>
      <path d="M6.5 3.5H4.2A1.7 1.7 0 0 0 2.5 5.2v6.6a1.7 1.7 0 0 0 1.7 1.7h6.6a1.7 1.7 0 0 0 1.7-1.7V9.5" />
      <path d="M9 3h4v4" />
      <line x1="13" y1="3" x2="7.5" y2="8.5" />
    </svg>
  )
}
