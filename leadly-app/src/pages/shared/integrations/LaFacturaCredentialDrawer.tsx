import { useEffect, useState } from 'react'
import {
  getIntegrationCredential,
  getIntegrationCredentialConfiguredSecrets,
  setIntegrationCredentialConfig,
  setIntegrationCredentialMode,
  setIntegrationCredentialSecret,
} from '../../../lib/api/integrations'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { IntegrationStatusBanner } from './IntegrationStatusBanner'
import { IntegrationFieldLabel, IntegrationSection } from './IntegrationFieldLabel'
import { useLanguage } from '../../../contexts/LanguageContext'

const PROVIDER_KEY = 'lafactura'
const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

/** LaFactura.co's own fields, named and typed -- not a generic JSON blob.
 * The fields themselves come from how the sibling `lexy` project's
 * emit-lafactura-invoice Edge Function reads its credential
 * (api_user/api_password/api_base_url/id_api/range_key/iva_rate). Adding a
 * new integration later means writing a form like this one for it, not
 * extending this component -- same pattern as tania-functions, where each
 * integration (HubSpot, Shopify, ...) gets its own typed config shape.
 * Shared between the backoffice (platform account, tenantId null) and each
 * tenant's own Integrations page (their own account, tenantId set). */
export function LaFacturaCredentialDrawer({
  open,
  onClose,
  tenantId,
  description,
}: {
  open: boolean
  onClose: () => void
  tenantId: string | null
  description: string
}) {
  const { t } = useLanguage()
  const [mode, setMode] = useState<'sandbox' | 'production'>('sandbox')
  const [apiBaseUrl, setApiBaseUrl] = useState('')
  const [idApi, setIdApi] = useState('')
  const [rangeKey, setRangeKey] = useState('')
  const [ivaRate, setIvaRate] = useState('19')
  const [apiUser, setApiUser] = useState('')
  const [apiPassword, setApiPassword] = useState('')
  const [configuredSecrets, setConfiguredSecrets] = useState<string[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!open) return
    setLoaded(false)
    setError(null)
    setSaved(false)
    setApiUser('')
    setApiPassword('')
    getIntegrationCredential(PROVIDER_KEY, tenantId)
      .then(async (credential) => {
        setMode(credential?.mode ?? 'sandbox')
        const config = (credential?.config ?? {}) as Record<string, unknown>
        setApiBaseUrl(typeof config.api_base_url === 'string' ? config.api_base_url : '')
        setIdApi(typeof config.id_api === 'string' ? config.id_api : '')
        setRangeKey(typeof config.range_key === 'string' ? config.range_key : '')
        setIvaRate(config.iva_rate !== undefined ? String(config.iva_rate) : '19')
        setConfiguredSecrets(credential ? await getIntegrationCredentialConfiguredSecrets(credential.id) : [])
        setLoaded(true)
      })
      .catch((err) => setError(err.message ?? t('integrations.errors.load')))
  }, [open, tenantId])

  async function handleModeChange(next: 'sandbox' | 'production') {
    setError(null)
    try {
      await setIntegrationCredentialMode(PROVIDER_KEY, tenantId, next)
      setMode(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('integrations.errors.save'))
    }
  }

  async function handleSubmit() {
    setSubmitting(true)
    setError(null)
    setSaved(false)
    try {
      await setIntegrationCredentialConfig(PROVIDER_KEY, tenantId, {
        api_base_url: apiBaseUrl.trim() || null,
        id_api: idApi.trim() || null,
        range_key: rangeKey.trim() || null,
        iva_rate: ivaRate.trim() ? Number(ivaRate) : null,
      })
      if (apiUser.trim()) await setIntegrationCredentialSecret(PROVIDER_KEY, tenantId, 'api_user', apiUser.trim())
      if (apiPassword.trim()) await setIntegrationCredentialSecret(PROVIDER_KEY, tenantId, 'api_password', apiPassword.trim())

      const credential = await getIntegrationCredential(PROVIDER_KEY, tenantId)
      setConfiguredSecrets(credential ? await getIntegrationCredentialConfiguredSecrets(credential.id) : [])
      setApiUser('')
      setApiPassword('')
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('integrations.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  const userConfigured = configuredSecrets.includes('api_user')
  const passwordConfigured = configuredSecrets.includes('api_password')

  return (
    <Drawer open={open} onClose={onClose} title="LaFactura.co" description={description}>
      {!loaded && !error && <p className="text-sm text-brand-400">{t('common.status.loading')}</p>}

      {loaded && (
        <div className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl bg-brand-50/60 p-3">
            <img src="/integrations/lafactura.png" alt="" className="h-10 w-10 shrink-0 object-contain" />
            <p className="text-xs leading-snug text-brand-500">{t('integrations.lafactura.hint')}</p>
          </div>

          <IntegrationStatusBanner
            connected={userConfigured && passwordConfigured}
            connectedText={t('integrations.lafactura.connected')}
            notConnectedText={t('integrations.lafactura.notConnected')}
          />

          <IntegrationSection title={t('integrations.section.credentials')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <IntegrationFieldLabel
                  htmlFor="lafactura-user"
                  label={t('integrations.lafactura.apiUser')}
                  badge={
                    userConfigured && (
                      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                        {t('integrations.configured')}
                      </Badge>
                    )
                  }
                />
                <Input
                  id="lafactura-user"
                  value={apiUser}
                  onChange={(e) => setApiUser(e.target.value)}
                  placeholder={userConfigured ? t('integrations.replaceValue') : undefined}
                  autoComplete="off"
                  className={FIELD_CLASS}
                />
              </div>
              <div>
                <IntegrationFieldLabel
                  htmlFor="lafactura-password"
                  label={t('integrations.lafactura.apiPassword')}
                  badge={
                    passwordConfigured && (
                      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                        {t('integrations.configured')}
                      </Badge>
                    )
                  }
                />
                <Input
                  id="lafactura-password"
                  type="password"
                  value={apiPassword}
                  onChange={(e) => setApiPassword(e.target.value)}
                  placeholder={passwordConfigured ? t('integrations.replaceValue') : undefined}
                  autoComplete="off"
                  className={FIELD_CLASS}
                />
              </div>
            </div>
          </IntegrationSection>

          <IntegrationSection title={t('integrations.section.settings')}>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <IntegrationFieldLabel htmlFor="lafactura-mode" label={t('integrations.mode')} />
                <Select value={mode} onValueChange={(v) => handleModeChange(v as 'sandbox' | 'production')}>
                  <SelectTrigger id="lafactura-mode" className={`w-full ${FIELD_CLASS}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sandbox" className="text-xs">
                      {t('integrations.mode.sandbox')}
                    </SelectItem>
                    <SelectItem value="production" className="text-xs">
                      {t('integrations.mode.production')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div>
                <IntegrationFieldLabel htmlFor="lafactura-iva-rate" label={t('integrations.lafactura.ivaRate')} />
                <Input id="lafactura-iva-rate" type="number" min={0} max={100} step={0.5} value={ivaRate} onChange={(e) => setIvaRate(e.target.value)} className={FIELD_CLASS} />
              </div>
            </div>

            <div>
              <IntegrationFieldLabel htmlFor="lafactura-base-url" label={t('integrations.lafactura.apiBaseUrl')} />
              <Input id="lafactura-base-url" value={apiBaseUrl} onChange={(e) => setApiBaseUrl(e.target.value)} placeholder="https://api.lafactura.co" className={FIELD_CLASS} />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <IntegrationFieldLabel htmlFor="lafactura-id-api" label={t('integrations.lafactura.idApi')} />
                <Input id="lafactura-id-api" value={idApi} onChange={(e) => setIdApi(e.target.value)} className={FIELD_CLASS} />
              </div>
              <div>
                <IntegrationFieldLabel htmlFor="lafactura-range-key" label={t('integrations.lafactura.rangeKey')} />
                <Input id="lafactura-range-key" value={rangeKey} onChange={(e) => setRangeKey(e.target.value)} className={FIELD_CLASS} />
              </div>
            </div>
          </IntegrationSection>

          {error && <FieldError message={error} />}

          <div className="flex items-center gap-2 border-t border-brand-100 pt-4">
            <Button type="button" onClick={handleSubmit} disabled={submitting}>
              {submitting ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
            {saved && <span className="text-xs text-emerald-600">{t('integrations.configSaved')}</span>}
          </div>
        </div>
      )}
    </Drawer>
  )
}
