import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

/** Compact field grouping using the existing type, spacing and color tokens. */
export function FormSection({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return <fieldset className={cn('flex min-w-0 flex-col gap-2.5', className)}><legend className="mb-2 text-sm font-semibold text-foreground">{title}</legend>{children}</fieldset>
}

export function FormToggle({ id, label, checked, onCheckedChange, disabled = false }: {
  id: string
  label: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
}) {
  return <div className="flex min-h-10 items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"><Label htmlFor={id}>{label}</Label><Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} /></div>
}
