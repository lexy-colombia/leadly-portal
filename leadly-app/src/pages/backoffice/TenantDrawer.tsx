import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { createTenant, updateTenant, uploadTenantLogo, validateTenantLogoFile } from '../../lib/api/tenants'
import type { Tenant } from '../../types/domain'
import { Button, Drawer, InitialsAvatar, Label } from '../../components/ui'
import { useTenantForm } from './useTenantForm'
import { TenantFormFields } from './TenantFormFields'
import { useLanguage } from '../../contexts/LanguageContext'

/** One drawer for both "nuevo cliente" and "editar cliente" -- editing no
 * longer means a form permanently sitting in the page, it opens this panel.
 *
 * Logo upload needs a tenant id to exist in storage, so the two modes differ:
 * editing an existing tenant uploads immediately on file pick; creating a new
 * one stages the file and uploads it right after the tenant row is created. */
export function TenantDrawer({
  open,
  onClose,
  tenant,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenant?: Tenant | null
  onSaved: (tenant: Tenant) => void
}) {
  const { t } = useLanguage()
  const isEdit = !!tenant
  const form = useTenantForm(tenant ?? undefined)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [logoUrl, setLogoUrl] = useState<string | null>(tenant?.logo_url ?? null)
  const [stagedLogoFile, setStagedLogoFile] = useState<File | null>(null)
  const [stagedLogoPreview, setStagedLogoPreview] = useState<string | null>(null)
  const [logoUploading, setLogoUploading] = useState(false)
  const [logoError, setLogoError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    form.setTouched(false)
    setFormError(null)
    setLogoUrl(tenant?.logo_url ?? null)
    setStagedLogoFile(null)
    setStagedLogoPreview(null)
    setLogoError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenant?.id])

  async function handleLogoPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return

    const validationError = validateTenantLogoFile(file)
    if (validationError) {
      setLogoError(validationError)
      return
    }
    setLogoError(null)

    if (isEdit && tenant) {
      setLogoUploading(true)
      try {
        const updated = await uploadTenantLogo(tenant.id, file)
        setLogoUrl(updated.logo_url)
        onSaved(updated)
      } catch (err) {
        setLogoError(err instanceof Error ? err.message : t('backoffice.tenantDrawer.errors.logoUpload'))
      } finally {
        setLogoUploading(false)
      }
    } else {
      setStagedLogoFile(file)
      setStagedLogoPreview(URL.createObjectURL(file))
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    form.setTouched(true)
    setFormError(null)
    if (!form.isValid()) return

    setSubmitting(true)
    try {
      let saved = isEdit && tenant ? await updateTenant(tenant.id, form.toInput()) : await createTenant(form.toInput())
      if (!isEdit && stagedLogoFile) {
        saved = await uploadTenantLogo(saved.id, stagedLogoFile)
      }
      onSaved(saved)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('backoffice.tenantDrawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  const previewLogo = stagedLogoPreview ?? logoUrl

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={isEdit ? t('backoffice.tenantDrawer.titleEdit') : t('backoffice.tenantDrawer.titleNew')}
      footer={
        <div className="flex gap-2">
          <Button type="submit" form="tenant-form" variant="secondary" disabled={submitting}>
            {submitting ? t('common.actions.saving') : isEdit ? t('common.actions.saveChanges') : t('backoffice.tenantDrawer.create')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      }
    >
      <div className="mb-6">
        <Label>{t('backoffice.tenantDrawer.logo')}</Label>
        <div className="flex items-center gap-4">
          {previewLogo ? (
            <img src={previewLogo} alt="" className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <InitialsAvatar name={form.name || t('backoffice.tenantDrawer.logoFallbackName')} size="lg" />
          )}
          <div>
            <Button type="button" variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={logoUploading}>
              {logoUploading ? t('backoffice.tenantDrawer.logoUploading') : previewLogo ? t('backoffice.tenantDrawer.logoChange') : t('backoffice.tenantDrawer.logoUpload')}
            </Button>
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" className="hidden" onChange={handleLogoPick} />
            <p className="mt-1 text-xs text-brand-400">{t('backoffice.tenantDrawer.logoHint')}</p>
          </div>
        </div>
        {logoError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{logoError}</p>}
      </div>

      <form id="tenant-form" onSubmit={handleSubmit} noValidate>
        <TenantFormFields form={form} />
        {formError && <p className="mt-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
      </form>
    </Drawer>
  )
}
