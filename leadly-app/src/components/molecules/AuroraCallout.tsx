import type { ReactNode } from 'react'
import { AiSparkleIcon } from '@/components/atoms/icons'

/** Aurora is Leadly's AI assistant brand (see CLAUDE.md). This callout reuses
 * the generic AiSparkleIcon placeholder until a dedicated Aurora glyph exists. */
export function AuroraCallout({ message }: { message: ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-accent-100 bg-accent-50 p-4">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-800 text-accent-400">
        <AiSparkleIcon width={18} height={18} />
      </span>
      <p className="text-sm text-brand-700">{message}</p>
    </div>
  )
}
