import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../../contexts/LanguageContext'

/** Reusable right-side sliding panel -- the app's one "modal" pattern, used for
 * every create/edit form (Cliente, Línea de WhatsApp, ...) instead of either a
 * centered dialog or dedicating a full route to a form. Closes on backdrop
 * click or Escape. Always mounted at <body> level via a portal so it stacks
 * above layout scroll containers correctly. */
export function Drawer({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  const { t } = useLanguage()

  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 animate-fade-in bg-brand-900/40" onClick={onClose} aria-hidden="true" />
      <div className="animate-slide-in-right absolute inset-y-0 right-0 flex w-full max-w-md flex-col bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-brand-100 px-6 py-5">
          <div>
            <h2 className="text-lg font-bold text-brand-800">{title}</h2>
            {description && <p className="mt-0.5 text-sm text-brand-400">{description}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.actions.close')}
            className="-mr-2 -mt-1 rounded-lg p-2 text-brand-300 hover:bg-brand-50 hover:text-brand-600"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer && <div className="border-t border-brand-100 px-6 py-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
