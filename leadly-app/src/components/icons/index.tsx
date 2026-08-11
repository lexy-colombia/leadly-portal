import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const DEFAULTS = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true } as const

export function MailIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h15A1.5 1.5 0 0 1 21 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z" stroke="currentColor" strokeWidth="1.6" />
      <path d="m4 7 8 6 8-6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10.5V7.5a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function EyeIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.75" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function EyeOffIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path
        d="M3.5 3.5l17 17M10.6 10.7a2.75 2.75 0 0 0 3.9 3.9M7.4 7.6C5 9.1 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.6 0 3-.4 4.2-1.1M16.6 16.6C19.4 14.9 21.5 12 21.5 12S18 5.5 12 5.5c-.7 0-1.4.08-2 .23"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function GoogleIcon(props: IconProps) {
  return (
    <svg width={18} height={18} viewBox="0 0 48 48" aria-hidden {...props}>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5Z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34.6 6 29.6 4 24 4c-7.6 0-14.2 4.3-17.7 10.7Z" />
      <path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.9 14.3-5.1l-6.6-5.6C29.6 34.9 26.9 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.6 5.1C9.7 39.6 16.3 44 24 44Z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3a12 12 0 0 1-4.1 5.6l6.6 5.6C41.4 36.3 44 30.7 44 24c0-1.3-.1-2.7-.4-3.5Z" />
    </svg>
  )
}

/** Generic four-point "AI" sparkle glyph -- a stand-in for the real Aurora
 * brand icon until design delivers one. Used anywhere the product needs to
 * signal "this is Aurora / AI-generated". */
export function AiSparkleIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} fill="currentColor" {...props}>
      <path d="M12 2c.6 3.2 1.3 5.1 2.4 6.6C15.5 10.1 17.3 11 20 12c-2.7 1-4.5 1.9-5.6 3.4C13.3 16.9 12.6 18.8 12 22c-.6-3.2-1.3-5.1-2.4-6.6C8.5 13.9 6.7 13 4 12c2.7-1 4.5-1.9 5.6-3.4C10.7 7.1 11.4 5.2 12 2Z" />
    </svg>
  )
}

export function ChatBubbleIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M4 5h16v10H8l-4 4V5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="8.5" cy="10" r="0.9" fill="currentColor" />
      <circle cx="12" cy="10" r="0.9" fill="currentColor" />
      <circle cx="15.5" cy="10" r="0.9" fill="currentColor" />
    </svg>
  )
}

export function TargetIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="4.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 2v3.5M22 12h-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function BarChartIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M5 20V11M12 20V4M19 20v-7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function MenuIcon(props: IconProps) {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" fill="none" aria-hidden {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function DashboardIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13" y="3.5" width="7.5" height="4.5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13" y="10.5" width="7.5" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="13.5" width="7.5" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function BuildingIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="4" y="3" width="12" height="18" rx="1" stroke="currentColor" strokeWidth="1.6" />
      <path d="M16 21h4V9l-4-2" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M7.5 7h1.5M11.5 7h1.5M7.5 11h1.5M11.5 11h1.5M7.5 15h1.5M11.5 15h1.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M6 9a6 6 0 1 1 12 0c0 4 1.5 5.5 1.5 5.5h-15S6 13 6 9Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10 18.5a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function UsersIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <circle cx="9" cy="8" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M16 4.5a3 3 0 0 1 0 5.8M19 20c0-2.8-1.8-5.1-4.3-5.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M15 5l-7 7 7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function PhoneIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="7" y="3" width="10" height="18" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 18h2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function PencilIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path
        d="M4 20l.9-3.6L15.6 5.7a1.5 1.5 0 0 1 2.1 0l1.6 1.6a1.5 1.5 0 0 1 0 2.1L8.6 20.1 4 20Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M14 7.5l3 3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function LogoutIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M16 17l5-5-5-5M21 12H9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function MapPinIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path
        d="M19 10.5c0 5.5-7 11-7 11s-7-5.5-7-11a7 7 0 1 1 14 0Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="10.5" r="2.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function GlobeIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 12h17M12 3.5c2.5 2.3 3.8 5.3 3.8 8.5s-1.3 6.2-3.8 8.5c-2.5-2.3-3.8-5.3-3.8-8.5S9.5 5.8 12 3.5Z" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function IdCardIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8.5" cy="12" r="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 16.5c.5-1.5 1.7-2.3 3-2.3s2.5.8 3 2.3M14 10h5M14 13.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  )
}

export function SendIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M4 20l16-8L4 4l2 8-2 8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M6 12h6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path d="m20 20-3.5-3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function LockClosedIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="4.5" y="10.5" width="15" height="9.5" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 10.5V7.5a4 4 0 1 1 8 0v3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function MegaphoneIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M3 10v4a1 1 0 0 0 1 1h2l1 4h2l-1-4h1l9 4V5l-9 4H4a1 1 0 0 0-1 1Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

export function CatalogIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="3.5" y="4" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13" y="4" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="3.5" y="13.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
      <rect x="13" y="13.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  )
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 3.5v2M12 18.5v2M20.5 12h-2M5.5 12h-2M17.66 6.34l-1.42 1.42M7.76 16.24l-1.42 1.42M17.66 17.66l-1.42-1.42M7.76 7.76 6.34 6.34"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function KeyIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <circle cx="8" cy="15" r="4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 12l8-8M16 4l3 3M13.5 6.5l2 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function CreditCardIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3 9.5h18M6.5 14.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function CalendarIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="3.5" y="5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M3.5 9.5h17M8 3v3.5M16 3v3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function XCircleIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m9 9 6 6M15 9l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function FilterIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M4 5h16M7 12h10M10.5 19h3" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path
        d="M4 12a8 8 0 0 1 13.66-5.66M20 12a8 8 0 0 1-13.66 5.66"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
      <path d="M17 3v4h-4M7 21v-4h4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function UserIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <circle cx="12" cy="8.5" r="3.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="M4.5 20c1.3-3.6 4.2-5.5 7.5-5.5s6.2 1.9 7.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function TagIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path
        d="M11.6 4H6.5A2.5 2.5 0 0 0 4 6.5v5.1c0 .53.21 1.04.59 1.41l7.4 7.4a2 2 0 0 0 2.82 0l5.1-5.1a2 2 0 0 0 0-2.82l-7.4-7.4A2 2 0 0 0 11.6 4Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <circle cx="8.2" cy="8.2" r="1.2" fill="currentColor" />
    </svg>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M4.5 7h15M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M6.5 7v12a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path
        d="M12 4.5 3.5 19h17L12 4.5Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M12 10v3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="12" cy="16" r="1" fill="currentColor" />
    </svg>
  )
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.6" />
      <path d="M12 7.5V12l3 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ArchiveIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="4" y="4.5" width="16" height="4" rx="1.2" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5 8.5v9.3a1.7 1.7 0 0 0 1.7 1.7h10.6a1.7 1.7 0 0 0 1.7-1.7V8.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M10 12.5h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function ImageIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="8.5" cy="9.5" r="1.5" stroke="currentColor" strokeWidth="1.6" />
      <path d="m5 17 4.5-4.5a1.5 1.5 0 0 1 2.1 0l1.4 1.4M14 13.5l1.4-1.4a1.5 1.5 0 0 1 2.1 0L20 14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function PaperclipIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path
        d="M8 12.5V7a4 4 0 1 1 8 0v9a2.5 2.5 0 0 1-5 0V8.5a1 1 0 1 1 2 0V15"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function FileIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M6.5 3.5h8l4 4v12.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M14 3.5V8h4.5" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

export function BoxIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M3.5 8 12 3.5 20.5 8 12 12.5 3.5 8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M3.5 8v9l8.5 4.5M20.5 8v9L12 21.5M12 12.5V21.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function ReceiptIcon(props: IconProps) {
  return (
    <svg {...DEFAULTS} {...props}>
      <path d="M6 3.5h12v17l-2.5-1.5-2 1.5-2-1.5-2 1.5-2-1.5L6 20.5v-17Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M9 8h6M9 11.5h6M9 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}
