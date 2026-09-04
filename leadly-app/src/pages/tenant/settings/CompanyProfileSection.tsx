import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../../../contexts/LanguageContext'
import { updateTenant, uploadTenantLogo, validateTenantLogoFile } from '../../../lib/api/tenants'
import type { Tenant } from '../../../types/domain'
import { InitialsAvatar } from '@/components/atoms'
import { Card, CardSection } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { PencilIcon, XCircleIcon } from '@/components/atoms/icons'
import { useTenantForm } from '../../backoffice/useTenantForm'
import { TenantFormFields } from '../../backoffice/TenantFormFields'

/** Label-above-value field, same shape ProductDetail/ClientDetail use for
 * their data sheets. */
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

/** "Perfil de la empresa" category -- read-only data sheet (logo + legal/
 * contact fields, 2 columns) that turns into an inline edit form in place
 * (no Drawer) when "Editar información" is pressed, closing with a bottom
 * Cancelar/Guardar cambios bar instead of a floating Guardar button. Reuses
 * the exact same form plumbing the backoffice's tenant editor already uses
 * (useTenantForm/TenantFormFields/updateTenant) -- only the container
 * changed from a slide-out Drawer to inline content. */
export function CompanyProfileSection({ tenant, onSaved }: { tenant: Tenant; onSaved: (tenant: Tenant) => void }) {
  const { t } = useLanguage()
  const [editing, setEditing] = useState(false)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)
  const [previewOpen, setPreviewOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  async function handleLogoPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    // validateTenantLogoFile (lib/api/tenants.ts) is shared with the
    // backoffice's own logo upload and still returns a literal Spanish
    // message -- not translated here, out of scope for this pass.
    const validationError = validateTenantLogoFile(file)
    if (validationError) {
      setLogoError(validationError)
      return
    }
    setLogoError(null)
    setLogoUploading(true)
    try {
      const updated = await uploadTenantLogo(tenant.id, file)
      onSaved(updated)
    } catch (err) {
      setLogoError(err instanceof Error ? err.message : t('settings.logo.errors.upload'))
    } finally {
      setLogoUploading(false)
    }
  }

  const documentValue = tenant.document_type && tenant.document_number ? `${tenant.document_type} ${tenant.document_number}` : tenant.document_number

  return (
    <Card padded={false}>
      <CardSection
        title={t('settings.company.title')}
        description={t('settings.company.description')}
        action={
          !editing && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <PencilIcon width={13} height={13} /> {t('settings.company.editAction')}
            </Button>
          )
        }
      >
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
          {logoError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{logoError}</p>}

          {editing ? (
            <CompanyProfileEditForm tenant={tenant} onCancel={() => setEditing(false)} onSaved={(updated) => { onSaved(updated); setEditing(false) }} />
          ) : (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3.5 border-t border-brand-100 pt-4 sm:grid-cols-2">
              <Field label={t('backoffice.tenantForm.name')} value={tenant.name} />
              <Field label={t('backoffice.clienteDetalle.fields.legalName')} value={tenant.legal_name} />
              <Field label={t('backoffice.tenantForm.documentType')} value={documentValue} />
              <Field label={t('backoffice.tenantForm.contactEmail')} value={tenant.contact_email} />
              <Field label={t('backoffice.tenantForm.contactPhone')} value={tenant.contact_phone} />
              <Field label={t('backoffice.tenantForm.country')} value={tenant.country} />
              <Field label={t('backoffice.tenantForm.stateProvince')} value={tenant.state_province} />
              <Field label={t('backoffice.tenantForm.billingAddress')} value={tenant.billing_address} />
            </dl>
          )}
        </div>
      </CardSection>
    </Card>
  )
}

function CompanyProfileEditForm({ tenant, onCancel, onSaved }: { tenant: Tenant; onCancel: () => void; onSaved: (tenant: Tenant) => void }) {
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
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('settings.company.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-4 border-t border-brand-100 pt-4">
      <TenantFormFields form={form} hideNotes compact />

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

      {/* Bottom bar, not a standalone Guardar button in the middle of the
          content -- pedido explícito del usuario. */}
      <div className="flex justify-end gap-2 border-t border-brand-100 pt-4">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          {t('common.actions.cancel')}
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? t('common.actions.saving') : t('settings.company.saveAction')}
        </Button>
      </div>
    </form>
  )
}
