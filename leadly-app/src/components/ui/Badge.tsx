import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger'

const TONES: Record<BadgeTone, { bg: string; text: string; dot: string }> = {
  neutral: { bg: 'bg-brand-50', text: 'text-brand-600', dot: 'bg-brand-400' },
  success: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500' },
  warning: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500' },
  danger: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500' },
}

// Same tones, tuned for a dark/gradient background (profile hero headers, sidebar).
const DARK_TONES: Record<BadgeTone, { bg: string; text: string; dot: string }> = {
  neutral: { bg: 'bg-white/10', text: 'text-white', dot: 'bg-white/70' },
  success: { bg: 'bg-emerald-400/15', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  warning: { bg: 'bg-amber-400/15', text: 'text-amber-300', dot: 'bg-amber-400' },
  danger: { bg: 'bg-red-400/15', text: 'text-red-300', dot: 'bg-red-400' },
}

export function Badge({ tone = 'neutral', dark = false, children }: { tone?: BadgeTone; dark?: boolean; children: ReactNode }) {
  const t = (dark ? DARK_TONES : TONES)[tone]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${t.bg} ${t.text}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${t.dot}`} />
      {children}
    </span>
  )
}
