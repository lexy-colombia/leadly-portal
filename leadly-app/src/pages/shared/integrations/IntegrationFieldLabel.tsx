import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'

/** Label + "Configurado" badge on one row, badge right-aligned -- putting a
 * Badge as a child of the shared `Label` component (block-level) made it
 * wrap flush against the text with no spacing. */
export function IntegrationFieldLabel({ htmlFor, label, badge }: { htmlFor?: string; label: string; badge?: ReactNode }) {
  return (
    <div className="mb-1 flex items-center justify-between gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {badge}
    </div>
  )
}

/** Groups related fields under a small uppercase heading inside a bordered
 * box -- same section-heading style as InvoiceDetailDrawer -- instead of a
 * flat pile of same-looking inputs. */
export function IntegrationSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-brand-100 p-3.5">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-brand-400">{title}</h3>
      <div className="space-y-3">{children}</div>
    </section>
  )
}
