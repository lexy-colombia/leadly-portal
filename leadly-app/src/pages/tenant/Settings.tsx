import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { getTenant, updateTenant, uploadTenantLogo, validateTenantLogoFile } from '../../lib/api/tenants'
import type { Tenant } from '../../types/domain'
import { Button, InitialsAvatar, PageSpinner } from '@/components/atoms'
import { Card, CardSection } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { PencilIcon, XCircleIcon } from '@/components/atoms/icons'
import { Warehouses } from './Warehouses'
import { DispatchStatusesSection } from './settings/DispatchStatusesSection'
import { ReturnStatusesSection } from './settings/ReturnStatusesSection'
import { ReturnResolutionTypesSection } from './settings/ReturnResolutionTypesSection'
import { useTenantForm } from '../backoffice/useTenantForm'
import { TenantFormFields } from '../backoffice/TenantFormFields'

/** Label-above-value field, same shape ProductDetail/ClientDetail use
 * for their data sheets. */
function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-brand-400">{label}</dt>
      <dd className="truncate text-sm text-brand-700">{value ?? '-'}</dd>
    </div>
  )
}

/** Full-size preview on click -- the thumbnail is only 20x20, a logo that
 * isn't a small icon (a wordmark, anything wide) is unreadable at that
 * size and there was previously no way to see it any bigger. Same overlay
 * pattern as ConfirmDialog (portal, backdrop, Escape-to-close). */
function LogoPreviewModal({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
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
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-6">
      <div className="absolute inset-0 animate-fade-in bg-brand-900/60" onClick={onClose} aria-hidden="true" />
      <div className="relative max-h-[85vh] max-w-[85vw] rounded-2xl bg-white p-3 shadow-2xl">
        <button
          type="button"
          onClick={onClose}
          className="absolute -right-2.5 -top-2.5 flex h-7 w-7 items-center justify-center rounded-full bg-white text-brand-500 shadow-md hover:text-brand-800"
        >
          <XCircleIcon width={18} height={18} />
        </button>
        <img src={src} alt={alt} className="max-h-[75vh] max-w-[75vw] rounded-xl object-contain" />
      </div>
    </div>,
    document.body,
  )
}

// Tags de conversación se movieron a Conversaciones (ChatPanel.tsx) el
// 2026-08-16 -- se usan y se gestionan ahí mismo, donde se asignan a una
// conversación, en vez de una pantalla aparte sin relación visual con
// dónde realmente se usan.
//
// El resto quedó como un solo Card dividido en CardSections (mismo patrón
// que MyAccount.tsx/Billing.tsx), sin el `max-w` angosto de la versión
// anterior -- con las tags afuera, forzar todo a una columna angosta
// dejaba la mitad de la pantalla vacía. La sección de la empresa es una
// vista de detalle de solo lectura (mismo patrón que ProductDetail/
// ClientDetail: Field grid + botón "Editar" que abre un Drawer) -- deja
// ver y, vía el drawer, editar los datos legales/de contacto que ya existen
// en `tenants` desde el alta (razón social, documento, contacto, dirección,
// país) y que el panel del tenant nunca mostraba ni dejaba tocar -- antes
// solo el backoffice podía verlos y editarlos. El drawer reutiliza el form
// del backoffice (useTenantForm/TenantFormFields, pages/backoffice/) tal
// cual, solo ocultando "Notas internas" (es comentario del superadmin
// sobre el cliente, no algo que el propio tenant deba ver ni editar).
export function Settings() {
  const { profile, enabledModules } = useAuth()
  const { t } = useLanguage()
  const isAdmin = profile?.role === 'tenant_admin'

  return (
    <div className="space-y-4">
      {isAdmin && <CompanySection />}
      {enabledModules?.has('inventory') && (
        <Card padded={false}>
          <CardSection title={t('inventory.warehouses.title')}>
            <Warehouses />
          </CardSection>
        </Card>
      )}
      {enabledModules?.has('dispatches') && profile?.tenant_id && (
        <Card padded={false}>
          <CardSection title={t('dispatches.settings.title')}>
            <DispatchStatusesSection tenantId={profile.tenant_id} />
          </CardSection>
        </Card>
      )}
      {enabledModules?.has('returns') && profile?.tenant_id && (
        <>
          <Card padded={false}>
            <CardSection title={t('returns.settings.statuses.title')}>
              <ReturnStatusesSection tenantId={profile.tenant_id} />
            </CardSection>
          </Card>
          <Card padded={false}>
            <CardSection title={t('returns.settings.resolutionTypes.title')}>
              <ReturnResolutionTypesSection tenantId={profile.tenant_id} />
            </CardSection>
          </Card>
        </>
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
  const [previewOpen, setPreviewOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
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
      <CardSection
        title={t('settings.company.title')}
        action={
          tenant && (
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-lg border border-brand-200 px-3 py-1.5 text-xs font-medium text-brand-600 transition-colors hover:bg-brand-50"
            >
              <PencilIcon width={13} height={13} /> {t('common.actions.edit')}
            </button>
          )
        }
      >
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        {!error && tenant === undefined && <PageSpinner />}
        {tenant && (
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <div className="relative shrink-0">
                {tenant.logo_url ? (
                  <button
                    type="button"
                    onClick={() => setPreviewOpen(true)}
                    className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-brand-100 bg-white p-1.5"
                    aria-label={t('settings.logo.viewLarger')}
                  >
                    <img src={tenant.logo_url} alt={tenant.name} className="max-h-full max-w-full object-contain" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={logoUploading}
                    className="flex h-20 w-20 items-center justify-center rounded-2xl bg-brand-50"
                    aria-label={t('settings.logo.upload')}
                  >
                    <InitialsAvatar name={tenant.name} size="lg" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={logoUploading}
                  aria-label={tenant.logo_url ? t('settings.logo.change') : t('settings.logo.upload')}
                  className="absolute -bottom-1.5 -right-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-brand-100 bg-white text-brand-500 shadow-sm transition-colors hover:bg-brand-50"
                >
                  <PencilIcon width={11} height={11} />
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/svg+xml"
                  className="hidden"
                  onChange={handleLogoPick}
                />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-brand-800">{tenant.name}</p>
                <p className="text-xs text-brand-400">{logoUploading ? t('settings.logo.uploading') : t('settings.logo.hint')}</p>
              </div>
            </div>
            {previewOpen && tenant.logo_url && <LogoPreviewModal src={tenant.logo_url} alt={tenant.name} onClose={() => setPreviewOpen(false)} />}

            <dl className="grid grid-cols-2 gap-x-6 gap-y-3.5 border-t border-brand-100 pt-4 sm:grid-cols-3">
              <Field label={t('backoffice.clienteDetalle.fields.legalName')} value={tenant.legal_name} />
              <Field label={t('backoffice.tenantForm.documentType')} value={documentValue} />
              <Field label={t('backoffice.tenantForm.contactEmail')} value={tenant.contact_email} />
              <Field label={t('backoffice.tenantForm.contactPhone')} value={tenant.contact_phone} />
              <Field label={t('backoffice.tenantForm.country')} value={tenant.country} />
              <Field label={t('backoffice.tenantForm.stateProvince')} value={tenant.state_province} />
              <Field label={t('backoffice.tenantForm.billingAddress')} value={tenant.billing_address} />
            </dl>
          </div>
        )}
        {logoError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{logoError}</p>}
      </CardSection>

      {tenant && <CompanyEditDrawer open={editOpen} onClose={() => setEditOpen(false)} tenant={tenant} onSaved={setTenant} />}
    </Card>
  )
}

/** The drawer shell is mounted as soon as `tenant` loads (so it's ready to
 * open instantly), but the form inside -- and its `useTenantForm(tenant)`
 * call -- only mounts while `open` is true. That's what makes reopening
 * after a cancel start clean again: `useTenantForm`'s initial values are
 * only read once, on mount, so without this the form would keep showing
 * whatever the user last typed instead of resetting to the real tenant
 * data (same risk WarehouseDrawer avoids with a reset useEffect -- this
 * mount/unmount approach gets the same result without duplicating that). */
function CompanyEditDrawer({
  open,
  onClose,
  tenant,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenant: Tenant
  onSaved: (tenant: Tenant) => void
}) {
  const { t } = useLanguage()
  return (
    <Drawer open={open} onClose={onClose} title={t('settings.company.title')}>
      {open && <CompanyEditForm tenant={tenant} onClose={onClose} onSaved={onSaved} />}
    </Drawer>
  )
}

function CompanyEditForm({ tenant, onClose, onSaved }: { tenant: Tenant; onClose: () => void; onSaved: (tenant: Tenant) => void }) {
  const { t } = useLanguage()
  const form = useTenantForm(tenant)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    form.setTouched(true)
    setFormError(null)
    if (!form.isValid()) return

    setSubmitting(true)
    try {
      const updated = await updateTenant(tenant.id, form.toInput())
      onSaved(updated)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('settings.company.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4">
      <TenantFormFields form={form} hideNotes compact />

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

      <div className="flex gap-2 border-t border-brand-100 pt-5">
        <Button type="submit" variant="secondary" disabled={submitting} className="!px-4 !py-2 text-sm">
          {submitting ? t('common.actions.saving') : t('common.actions.save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
          {t('common.actions.cancel')}
        </Button>
      </div>
    </form>
  )
}
