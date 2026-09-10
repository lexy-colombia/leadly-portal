import { CheckCircle2Icon, CircleAlertIcon, InfoIcon, XIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

export type ToastVariant = 'success' | 'error' | 'info'

export interface ToastItem {
  id: string
  title: string
  description?: string
  variant: ToastVariant
}

const VARIANT_ICON = {
  success: CheckCircle2Icon,
  error: CircleAlertIcon,
  info: InfoIcon,
} as const

/** El color solo codifica el resultado (salió bien / falló / es un aviso),
 * nunca el módulo que lo emitió -- mismo criterio que se acordó para los
 * estados del Calendario. */
const VARIANT_CLASS: Record<ToastVariant, string> = {
  success: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  info: 'border-border bg-background text-foreground',
}

const VARIANT_ICON_CLASS: Record<ToastVariant, string> = {
  success: 'text-emerald-600',
  error: 'text-destructive',
  info: 'text-muted-foreground',
}

/** Pila de toasts. La renderiza el ToastProvider una sola vez en la raíz,
 * así que sobrevive a que se desmonte el componente que emitió el mensaje
 * (el caso de "guardar y cerrar el drawer").
 *
 * Mobile-first: en pantalla chica ocupa el ancho completo abajo, y recién
 * desde `sm` se ancla a la esquina inferior derecha con ancho fijo. */
export function Toaster({
  toasts,
  onDismiss,
  dismissLabel,
}: {
  toasts: ToastItem[]
  onDismiss: (id: string) => void
  /** Etiqueta accesible del botón de cerrar -- viene traducida del
   * provider, este componente no habla con el contexto de idioma. */
  dismissLabel: string
}) {
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-center gap-2 p-4 sm:inset-x-auto sm:right-0 sm:items-end">
      {toasts.map((item) => {
        const Icon = VARIANT_ICON[item.variant]
        return (
          <div
            key={item.id}
            // `alert`/`assertive` solo para el error: un éxito no debería
            // interrumpir lo que esté leyendo un lector de pantalla.
            role={item.variant === 'error' ? 'alert' : 'status'}
            aria-live={item.variant === 'error' ? 'assertive' : 'polite'}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-lg border p-3 shadow-lg',
              'animate-in fade-in slide-in-from-bottom-2 duration-200',
              VARIANT_CLASS[item.variant],
            )}
          >
            <Icon className={cn('mt-0.5 size-4 shrink-0', VARIANT_ICON_CLASS[item.variant])} />
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold">{item.title}</p>
              {item.description && <p className="mt-0.5 text-xs opacity-80">{item.description}</p>}
            </div>
            <button
              type="button"
              onClick={() => onDismiss(item.id)}
              aria-label={dismissLabel}
              className="-m-1 shrink-0 rounded p-1 opacity-60 transition-opacity hover:opacity-100"
            >
              <XIcon className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
