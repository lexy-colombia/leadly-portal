import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Toaster, type ToastItem, type ToastVariant } from '../components/ui/toast'
import { useLanguage } from './LanguageContext'

/** Servicio de notificaciones efímeras (toasts) de toda la app.
 *
 * Hasta ahora cada pantalla resolvía "salió bien" a su manera -- lo más
 * común era un `useState` con un texto verde al lado del botón Guardar,
 * que el usuario tenía que ir a buscar con la vista y que desaparecía sin
 * dejar rastro al cerrar el formulario. Este contexto centraliza eso en un
 * único lugar visible: la confirmación aparece siempre en el mismo sitio,
 * sin importar desde qué drawer/página se disparó, y sobrevive a que el
 * componente que la emitió se desmonte (justamente el caso de "guardar y
 * cerrar el drawer" -- el toast lo renderiza el provider, no el drawer).
 *
 * No se sumó ninguna librería (sonner/react-hot-toast): el alcance real es
 * una cola con auto-descarte, así que se implementa con el mismo patrón de
 * contexto que ya usan AuthContext/LanguageContext y se estiliza con los
 * tokens del propio sistema de diseño. */

interface ShowToastOptions {
  title: string
  description?: string
  variant?: ToastVariant
  /** Milisegundos antes de descartarse solo. `0` lo deja fijo hasta que el
   * usuario lo cierre -- útil para un error que conviene poder leer con
   * calma o copiar. */
  durationMs?: number
}

interface ToastContextValue {
  toast: (options: ShowToastOptions) => string
  success: (title: string, description?: string) => string
  error: (title: string, description?: string) => string
  info: (title: string, description?: string) => string
  dismiss: (id: string) => void
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)

/** Un error se queda más tiempo que un éxito: el éxito solo confirma algo
 * que el usuario acaba de hacer a propósito, el error tiene contenido que
 * hay que leer. */
const DEFAULT_DURATION_MS: Record<ToastVariant, number> = {
  success: 3500,
  info: 4500,
  error: 7000,
}
/** Más de esto en pantalla a la vez no se alcanza a leer -- entra el nuevo
 * y se va el más viejo. */
const MAX_VISIBLE = 3

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useLanguage()
  const [toasts, setToasts] = useState<ToastItem[]>([])
  // Los timers viven en un ref (no en estado) para poder limpiarlos al
  // desmontar sin que cada alta/baja dispare un render extra.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
    setToasts((current) => current.filter((item) => item.id !== id))
  }, [])

  const toast = useCallback(
    ({ title, description, variant = 'info', durationMs }: ShowToastOptions) => {
      const id = crypto.randomUUID()
      setToasts((current) => [...current, { id, title, description, variant }].slice(-MAX_VISIBLE))
      const duration = durationMs ?? DEFAULT_DURATION_MS[variant]
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => {
            timers.current.delete(id)
            setToasts((current) => current.filter((item) => item.id !== id))
          }, duration),
        )
      }
      return id
    },
    [],
  )

  useEffect(() => {
    const pending = timers.current
    return () => {
      pending.forEach((timer) => clearTimeout(timer))
      pending.clear()
    }
  }, [])

  const value = useMemo<ToastContextValue>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => toast({ title, description, variant: 'success' }),
      error: (title, description) => toast({ title, description, variant: 'error' }),
      info: (title, description) => toast({ title, description, variant: 'info' }),
    }),
    [toast, dismiss],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <Toaster toasts={toasts} onDismiss={dismiss} dismissLabel={t('common.actions.close')} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
