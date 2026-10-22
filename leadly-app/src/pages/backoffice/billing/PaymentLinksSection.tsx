import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  getPaymentReadiness,
  type PaymentHealth,
  listPaymentClients,
  type PaymentClient,
  type PaymentReadiness,
} from '../../../lib/api/paymentLinks'
import { PageSpinner } from '@/components/atoms'
import { Card } from '@/components/molecules'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { CopyButton } from './CopyButton'
import { PaymentLinksPanel } from './PaymentLinksPanel'
import { PaymentProjectsPanel } from './PaymentProjectsPanel'

const HEALTH_KEYS: (keyof PaymentHealth)[] = [
  'invalid_signature',
  'unverified',
  'verification_mismatch',
  'transaction_conflict',
  'amount_mismatch',
  'duplicate_payment',
  'deliveries_failed',
  'stale_pending_links',
]

function HealthWarning({ health }: { health: PaymentHealth | null | undefined }) {
  const { t } = useLanguage()
  if (!health) return null
  const issues = HEALTH_KEYS.filter((k) => Number(health[k]) > 0)
  if (issues.length === 0) return null
  return (
    <div role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
      <p className="font-medium">{t('paymentLinks.health.title')}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {issues.map((k) => (
          <li key={k}>{t(`paymentLinks.health.${k}` as TranslationKey, { count: health[k] })}</li>
        ))}
      </ul>
    </div>
  )
}

function ConnectionCard({ readiness, error, onRetry }: { readiness: PaymentReadiness | null; error: string | null; onRetry: () => void }) {
  const { t } = useLanguage()
  const modeLabel =
    readiness?.platform_credential.mode === 'production'
      ? t('paymentLinks.connection.modeProduction')
      : readiness?.platform_credential.mode === 'sandbox'
        ? t('paymentLinks.connection.modeSandbox')
        : t('paymentLinks.connection.modeUnknown')

  return (
    <Card>
      <h3 className="mb-3 text-xs font-bold text-brand-800">{t('paymentLinks.connection.title')}</h3>
      {error && (
        <div role="alert" className="flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          <span>
            {t('paymentLinks.connection.loadError')} {error}
          </span>
          <Button variant="outline" size="xs" onClick={onRetry}>
            {t('common.actions.retry')}
          </Button>
        </div>
      )}
      {!readiness && !error && <PageSpinner />}
      {readiness && (
        <div className="space-y-3 text-xs">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <span className="flex items-center gap-2 text-brand-600">
              {t('paymentLinks.connection.credential')}
              <Badge
                variant="outline"
                className={
                  readiness.platform_credential.configured
                    ? 'border-transparent bg-emerald-100 text-emerald-700'
                    : 'border-transparent bg-red-100 text-red-700'
                }
              >
                {t(readiness.platform_credential.configured ? 'paymentLinks.connection.credentialOk' : 'paymentLinks.connection.credentialMissing')}
              </Badge>
            </span>
            <span className="text-brand-600">
              {t('paymentLinks.connection.mode')}: <span className="font-medium text-brand-800">{modeLabel}</span>
            </span>
            <span className="text-brand-600">
              {t('paymentLinks.connection.activeProjects')}: <span className="font-medium text-brand-800">{readiness.clients_active}</span>
            </span>
          </div>

          <HealthWarning health={readiness.health} />

          <div>
            <label htmlFor="pay-events-url" className="mb-1 block font-medium text-brand-700">
              {t('paymentLinks.connection.eventsUrl')}
            </label>
            <div className="flex items-center gap-2">
              <input
                id="pay-events-url"
                readOnly
                value={readiness.events_url}
                onFocus={(e) => e.currentTarget.select()}
                className="min-w-0 flex-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 font-mono text-xs text-brand-800"
              />
              <CopyButton value={readiness.events_url} />
            </div>
          </div>

          <Link to="/backoffice/integrations" className="inline-block font-medium text-accent-600 hover:text-accent-700">
            {t('paymentLinks.connection.loadKeys')}
          </Link>
        </div>
      )}
    </Card>
  )
}

/** Pestaña "Links de pago" de Facturación del backoffice (contrato:
 * progress/payments_interface_spec.md §5). Toda la comunicación con la API
 * pasa por lib/api/paymentLinks.ts. */
export function PaymentLinksSection() {
  const [readiness, setReadiness] = useState<PaymentReadiness | null>(null)
  const [readinessError, setReadinessError] = useState<string | null>(null)
  const [projects, setProjects] = useState<PaymentClient[] | null>(null)
  const [projectsError, setProjectsError] = useState<string | null>(null)

  const loadReadiness = useCallback(() => {
    setReadinessError(null)
    setReadiness(null)
    getPaymentReadiness()
      .then(setReadiness)
      .catch((err) => setReadinessError(err instanceof Error ? err.message : String(err)))
  }, [])

  const loadProjects = useCallback(() => {
    setProjectsError(null)
    listPaymentClients()
      .then(setProjects)
      .catch((err) => setProjectsError(err instanceof Error ? err.message : String(err)))
  }, [])

  useEffect(() => {
    loadReadiness()
    loadProjects()
  }, [loadReadiness, loadProjects])

  return (
    <div className="space-y-3">
      <ConnectionCard readiness={readiness} error={readinessError} onRetry={loadReadiness} />
      <PaymentProjectsPanel
        projects={projects}
        error={projectsError}
        onReload={() => {
          loadProjects()
          // "proyectos activos" de la tarjeta cambia al crear/suspender.
          getPaymentReadiness().then(setReadiness).catch(() => undefined)
        }}
      />
      <PaymentLinksPanel projects={projects} />
    </div>
  )
}
