import type { ReactNode } from 'react'

export function Card({
  className = '',
  hover = false,
  padded = true,
  children,
}: {
  className?: string
  /** Subtle lift + shadow growth on hover -- use for cards that are themselves clickable. */
  hover?: boolean
  /** Set to false when the card is a container for its own internally-padded
   * sections (e.g. a detail page split into divide-y sections) instead of a
   * single block of content. */
  padded?: boolean
  children: ReactNode
}) {
  return (
    <div
      className={`rounded-2xl border border-brand-100/70 bg-white transition-shadow duration-200 ${
        padded ? 'p-4 sm:p-5' : ''
      } ${hover ? 'hover:border-brand-200 hover:shadow-[0_2px_10px_-4px_rgba(16,26,53,0.10)]' : ''} ${className}`}
    >
      {children}
    </div>
  )
}

/** A titled section inside a `padded={false}` Card -- draws the divider that
 * separates it from the next section instead of each section being its own
 * floating Card. Pass `action` for a header-right button (e.g. "Editar"). */
export function CardSection({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="border-t border-brand-100 p-4 first:border-t-0 sm:p-5">
      <div className="mb-3.5 flex items-center justify-between gap-3">
        <h2 className="font-semibold text-brand-700">{title}</h2>
        {action}
      </div>
      {children}
    </div>
  )
}
