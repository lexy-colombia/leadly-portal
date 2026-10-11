import { useCallback, useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { AlertTriangleIcon, BanIcon, CheckCircle2Icon, ClockIcon, Loader2Icon, RotateCcwIcon, SearchXIcon, XCircleIcon } from 'lucide-react'
import { useLanguage } from '../contexts/LanguageContext'
import { Button } from '@/components/ui/button'
import {
  fetchPublicPaymentStatus,
  parsePaymentLinkId,
  type PublicPaymentStatus,
} from '../lib/api/paymentResult'
import esMessages from '../i18n/locales/es/paymentResult.json'
import enMessages from '../i18n/locales/en/paymentResult.json'

const POLL_INTERVAL_MS = 3000
const POLL_WINDOW_MS = 60000

type MessageKey = keyof typeof esMessages

type View =
  | { kind: 'loading' }
  | { kind: 'network-error' }
  | { kind: 'result'; result: PublicPaymentStatus; timedOut: boolean }

interface Presentation {
  icon: typeof CheckCircle2Icon
  tone: string
  title: MessageKey
  description: MessageKey
  extra?: MessageKey
  spinning?: boolean
}

function present(view: Extract<View, { kind: 'result' }>): Presentation {
  const { result, timedOut } = view
  switch (result.status) {
    case 'paid':
      return { icon: CheckCircle2Icon, tone: 'text-emerald-600 bg-emerald-50', title: 'paymentResult.paid.title', description: 'paymentResult.paid.description' }
    case 'pending': {
      if (result.lastAttempt === 'DECLINED' || result.lastAttempt === 'ERROR') {
        return {
          icon: XCircleIcon,
          tone: 'text-amber-600 bg-amber-50',
          title: 'paymentResult.declined.title',
          description: 'paymentResult.declined.description',
          extra: timedOut ? 'paymentResult.pending.timeout' : 'paymentResult.declined.checking',
        }
      }
      if (timedOut) {
        return { icon: ClockIcon, tone: 'text-primary bg-primary/10', title: 'paymentResult.pending.title', description: 'paymentResult.pending.timeout' }
      }
      return { icon: Loader2Icon, tone: 'text-primary bg-primary/10', title: 'paymentResult.pending.title', description: 'paymentResult.pending.description', spinning: true }
    }
    case 'expired':
    case 'cancelled':
      return { icon: BanIcon, tone: 'text-muted-foreground bg-muted', title: 'paymentResult.closed.title', description: 'paymentResult.closed.description' }
    case 'voided':
      return { icon: BanIcon, tone: 'text-muted-foreground bg-muted', title: 'paymentResult.voided.title', description: 'paymentResult.voided.description' }
    case 'error':
      return { icon: AlertTriangleIcon, tone: 'text-destructive bg-destructive/10', title: 'paymentResult.error.title', description: 'paymentResult.error.description' }
    default:
      return { icon: SearchXIcon, tone: 'text-muted-foreground bg-muted', title: 'paymentResult.unknown.title', description: 'paymentResult.unknown.description' }
  }
}

/** Página pública a la que Wompi devuelve al NAVEGADOR de quien pagó
 * (`/pago/resultado?link=<id>`). Sirve igual a la plataforma y a los tenants.
 *
 * REGLA DE ORO: nunca decide si el pago fue aprobado. Solo muestra el estado
 * que el backend ya conoce por el webhook. Los parámetros que agrega Wompi
 * (p. ej. `?id=`) se ignoran por completo. No muestra marca de ningún tenant
 * ni dato personal, y no guarda nada en el navegador. */
export function PaymentResult() {
  const { language } = useLanguage()
  const [params] = useSearchParams()
  const linkId = useMemo(() => parsePaymentLinkId(params.get('link')), [params])
  const [view, setView] = useState<View>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  const messages = language === 'en' ? enMessages : esMessages
  const tr = useCallback((key: MessageKey) => messages[key] ?? key, [messages])

  useEffect(() => {
    if (!linkId) return
    const controller = new AbortController()
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined

    const tick = async () => {
      try {
        const result = await fetchPublicPaymentStatus(linkId, controller.signal)
        if (controller.signal.aborted) return
        if (result.status === 'pending') {
          const timedOut = Date.now() - startedAt >= POLL_WINDOW_MS
          setView({ kind: 'result', result, timedOut })
          if (!timedOut) timer = setTimeout(tick, POLL_INTERVAL_MS)
        } else {
          setView({ kind: 'result', result, timedOut: false })
        }
      } catch {
        if (controller.signal.aborted) return
        setView({ kind: 'network-error' })
      }
    }
    void tick()

    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [linkId, attempt])

  const retry = () => {
    setView({ kind: 'loading' })
    setAttempt((n) => n + 1)
  }

  let content: { icon: Presentation['icon']; tone: string; title: string; description: string; extra?: string; spinning?: boolean; alert?: boolean }
  if (!linkId) {
    content = { icon: SearchXIcon, tone: 'text-muted-foreground bg-muted', title: tr('paymentResult.unknown.title'), description: tr('paymentResult.unknown.description') }
  } else if (view.kind === 'loading') {
    content = { icon: Loader2Icon, tone: 'text-primary bg-primary/10', title: tr('paymentResult.loading'), description: '', spinning: true }
  } else if (view.kind === 'network-error') {
    content = { icon: AlertTriangleIcon, tone: 'text-destructive bg-destructive/10', title: tr('paymentResult.network.title'), description: tr('paymentResult.network.description'), alert: true }
  } else {
    const p = present(view)
    content = { icon: p.icon, tone: p.tone, title: tr(p.title), description: tr(p.description), extra: p.extra ? tr(p.extra) : undefined, spinning: p.spinning }
  }
  const Icon = content.icon

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <section
        role={content.alert ? 'alert' : 'status'}
        aria-live={content.alert ? 'assertive' : 'polite'}
        aria-busy={view.kind === 'loading' && !!linkId}
        className="w-full max-w-md rounded-xl border border-border bg-card p-6 text-center shadow-sm sm:p-8"
      >
        <div className={`mx-auto flex size-14 items-center justify-center rounded-full ${content.tone}`}>
          <Icon className={`size-7 ${content.spinning ? 'animate-spin' : ''}`} aria-hidden="true" />
        </div>
        <h1 className="mt-5 text-lg font-semibold text-card-foreground">{content.title}</h1>
        {content.description && <p className="mt-2 text-sm text-muted-foreground">{content.description}</p>}
        {content.extra && <p className="mt-2 text-sm text-muted-foreground">{content.extra}</p>}
        {view.kind === 'network-error' && linkId && (
          <Button onClick={retry} className="mt-6 gap-2">
            <RotateCcwIcon className="size-4" aria-hidden="true" />
            {tr('paymentResult.network.retry')}
          </Button>
        )}
      </section>
    </main>
  )
}
