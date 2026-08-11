import type { ComponentType, ReactNode } from 'react'
import { Card } from '../../components/ui'
import { LockClosedIcon } from '../../components/icons'

/** Placeholder for features that are visible in the nav (so the product feels
 * complete in a demo/sales context) but intentionally not built yet --
 * Campañas and Catálogo. Distinct from AccessDenied: this isn't a permissions
 * problem, it's "coming soon". */
export function LockedFeature({
  icon: Icon,
  description,
}: {
  icon: ComponentType<{ width?: number; height?: number }>
  description: ReactNode
}) {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-col items-center gap-3 px-4 py-14 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-brand-300">
            <Icon width={26} height={26} />
          </span>
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <LockClosedIcon width={14} height={14} />
          </span>
          <p className="max-w-sm text-sm text-brand-500">{description}</p>
        </div>
      </Card>
    </div>
  )
}
