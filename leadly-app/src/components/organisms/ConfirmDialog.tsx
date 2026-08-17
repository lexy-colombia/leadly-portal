import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button, type ButtonVariant } from '@/components/atoms/Button'

/** Centered modal for a single destructive/important confirmation (delete,
 * disconnect, deactivate...) -- distinct from Drawer, which is for forms.
 * Confirming an action inline next to its trigger button (two small buttons
 * appearing in place) reads as part of the normal UI and is easy to
 * mis-click; a modal forces a deliberate, separate decision. Closes on
 * backdrop click or Escape, same as Drawer. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  confirmVariant = 'danger',
  loading = false,
  error,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  confirmVariant?: ButtonVariant
  loading?: boolean
  error?: string | null
}) {
  const { t } = useLanguage()
  const resolvedConfirmLabel = confirmLabel ?? t('common.actions.confirm')
  const resolvedCancelLabel = cancelLabel ?? t('common.actions.cancel')

  useEffect(() => {
    if (!open) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !loading) onClose()
    }
    document.addEventListener('keydown', handleKey)
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.style.overflow = prevOverflow
    }
  }, [open, onClose, loading])

  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-brand-900/40" onClick={() => !loading && onClose()} aria-hidden="true" />
      <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="text-base font-semibold text-brand-800">{title}</h2>
        <p className="mt-2 text-sm text-brand-500">{description}</p>
        {error && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={loading} className="!px-3.5 !py-2 text-sm">
            {resolvedCancelLabel}
          </Button>
          <Button type="button" variant={confirmVariant} onClick={onConfirm} disabled={loading} className="!px-3.5 !py-2 text-sm">
            {loading ? t('common.status.processing') : resolvedConfirmLabel}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
