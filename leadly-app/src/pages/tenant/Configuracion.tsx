import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { getTenant, uploadTenantLogo, validateTenantLogoFile } from '../../lib/api/tenants'
import type { Tenant } from '../../types/domain'
import { Card, CardSection, InitialsAvatar, PageSpinner } from '../../components/ui'
import { PencilIcon } from '../../components/icons'
import { Bodegas } from './Bodegas'

/** Label-above-value field, same shape ProductoDetalle/ContactoDetalle use
 * for their data sheets -- reused here instead of inventing a third layout
 * for "a fact about an entity". */
function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-brand-400">{label}</dt>
      <dd className="truncate text-sm text-brand-700">{value ?? '-'}</dd>
    </div>
  )
}

// Tags de conversación se movieron a Conversaciones (ChatPanel.tsx) el
// 2026-08-16 -- se usan y se gestionan ahí mismo, donde se asignan a una
// conversación, en vez de una pantalla aparte sin relación visual con
// dónde realmente se usan.
//
// El resto quedó como un solo Card dividido en CardSections (mismo patrón
// que MiCuenta.tsx/Facturacion.tsx), sin el `max-w` angosto de la versión
// anterior -- con las tags afuera, forzar todo a una columna angosta
// dejaba la mitad de la pantalla vacía. La sección de la empresa ahora
// también muestra los datos legales/de contacto que ya existen en
// `tenants` desde el alta (razón social, documento, contacto, país) y que
// el panel del tenant nunca mostraba -- antes solo el backoffice los veía.
export function Configuracion() {
  const { profile, enabledModules } = useAuth()
  const { t } = useLanguage()
  const isAdmin = profile?.role === 'tenant_admin'

  return (
    <div className="space-y-4">
      {isAdmin && <CompanySection />}
      {enabledModules?.has('inventory') && (
        <Card padded={false}>
          <CardSection title={t('inventory.warehouses.title')}>
            <Bodegas />
          </CardSection>
        </Card>
      )}
    </div>
  )
}

function CompanySection() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const [tenant, setTenant] = useState<Tenant | null | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!profile?.tenant_id) return
    getTenant(profile.tenant_id)
      .then(setTenant)
      .catch((err) => setError(err.message ?? t('settings.logo.errors.load')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.tenant_id])

  async function handleLogoPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !profile?.tenant_id) return

    // validateTenantLogoFile (lib/api/tenants.ts) is shared with the
    // backoffice's own logo upload and still returns a literal Spanish
    // message -- not translated here, out of scope for this pass (see i18n
    // handoff notes: lib/api/tenants.ts isn't one of this module's files).
    const validationError = validateTenantLogoFile(file)
    if (validationError) {
      setLogoError(validationError)
      return
    }
    setLogoError(null)
    setLogoUploading(true)
    try {
      const updated = await uploadTenantLogo(profile.tenant_id, file)
      setTenant(updated)
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : t('settings.logo.errors.upload'))
    } finally {
      setLogoUploading(false)
    }
  }

  const documentValue = tenant?.document_type && tenant.document_number ? `${tenant.document_type} ${tenant.document_number}` : tenant?.document_number

  return (
    <Card padded={false}>
      <CardSection title={t('settings.company.title')}>
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!error && tenant === undefined && <PageSpinner />}
        {tenant && (
          <div className="flex flex-col gap-5 md:flex-row md:items-start">
            <div className="flex shrink-0 items-center gap-3 md:w-56">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={logoUploading}
                className="group relative shrink-0 rounded-full"
                aria-label={tenant.logo_url ? t('settings.logo.change') : t('settings.logo.upload')}
              >
                {tenant.logo_url ? (
                  <img src={tenant.logo_url} alt="" className="h-12 w-12 rounded-full object-cover" />
                ) : (
                  <InitialsAvatar name={tenant.name} size="lg" />
                )}
                <span className="absolute -bottom-0.5 -right-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-brand-100 bg-white text-brand-500 shadow-sm transition-colors group-hover:bg-brand-50">
                  <PencilIcon width={10} height={10} />
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={handleLogoPick}
                />
              </button>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-brand-800">{tenant.name}</p>
                <p className="text-xs text-brand-400">{logoUploading ? t('settings.logo.uploading') : t('settings.logo.hint')}</p>
              </div>
            </div>

            <dl className="grid flex-1 grid-cols-2 gap-x-6 gap-y-3.5 border-t border-brand-100 pt-4 sm:grid-cols-3 md:border-t-0 md:border-l md:pl-6 md:pt-0">
              <Field label={t('settings.company.legalName')} value={tenant.legal_name} />
              <Field label={t('settings.company.document')} value={documentValue} />
              <Field label={t('settings.company.contactEmail')} value={tenant.contact_email} />
              <Field label={t('settings.company.contactPhone')} value={tenant.contact_phone} />
              <Field label={t('settings.company.country')} value={tenant.country} />
              <Field label={t('settings.company.stateProvince')} value={tenant.state_province} />
            </dl>
          </div>
        )}
        {logoError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{logoError}</p>}
      </CardSection>
    </Card>
  )
}
