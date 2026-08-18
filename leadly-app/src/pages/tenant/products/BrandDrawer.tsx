import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createBrand, removeBrandLogo, updateBrand, uploadBrandLogo, validateBrandLogoFile } from '../../../lib/api/brands'
import type { Brand } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Button, FieldError, Input, Label, Switch } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { isNotBlank } from '../../../lib/validation'

/** Storage-only picker -- doesn't persist `logo_url` itself, just uploads/
 * removes the file and reports the resulting URL up via onUploaded/onRemoved.
 * BrandDrawer saves it together with name/is_active on submit, same as every
 * other field, so this works identically whether creating a brand (no row
 * yet, `brandId` is a client-generated id used as the future row's id) or
 * editing one. Square, object-contain preview (not object-cover) so a
 * non-square logo doesn't get cropped -- same fix already applied to the
 * tenant logo preview. */
function BrandLogoPicker({
  tenantId,
  brandId,
  name,
  logoUrl,
  onUploaded,
  onRemoved,
}: {
  tenantId: string
  brandId: string
  name: string
  logoUrl: string | null
  onUploaded: (url: string) => void
  onRemoved: () => void
}) {
  const { t } = useLanguage()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file) return
    const validationError = validateBrandLogoFile(file)
    if (validationError) {
      setError(t(validationError))
      return
    }
    setError(null)
    setBusy(true)
    try {
      const url = await uploadBrandLogo(tenantId, brandId, file)
      onUploaded(url)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.brands.logo.errors.upload'))
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove() {
    setError(null)
    setBusy(true)
    try {
      await removeBrandLogo(tenantId, brandId)
      onRemoved()
    } catch {
      setError(t('products.brands.logo.errors.remove'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Label>{t('products.brands.logo.label')}</Label>
      <div className="flex items-center gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-brand-100 bg-brand-50">
          {logoUrl ? (
            <img src={logoUrl} alt={name} className="max-h-full max-w-full object-contain" />
          ) : (
            <span className="text-[10px] text-brand-300">{t('products.brands.logo.label')}</span>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Button type="button" variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy} className="!px-3 !py-1.5 text-xs">
            {busy ? t('products.brands.logo.uploading') : t(logoUrl ? 'products.brands.logo.change' : 'products.brands.logo.upload')}
          </Button>
          {logoUrl && (
            <Button type="button" variant="ghost" onClick={handleRemove} disabled={busy} className="!px-3 !py-1 text-xs !text-red-600 hover:!bg-red-50">
              {t('products.brands.logo.remove')}
            </Button>
          )}
        </div>
      </div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={handleSelect} />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

export function BrandDrawer({
  open,
  onClose,
  tenantId,
  brand,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  brand?: Brand | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [isActive, setIsActive] = useState(true)
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  // Stable id for the logo's storage path even before the brand row exists --
  // regenerated each time the drawer opens fresh for a new brand (an editing
  // session just reuses the real brand.id instead). createBrand passes this
  // same id explicitly (see BrandInput.id) rather than letting Postgres
  // generate one, so the storage path and the row's real id never diverge.
  const [pendingId, setPendingId] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(brand?.name ?? '')
    setIsActive(brand?.is_active ?? true)
    setLogoUrl(brand?.logo_url ?? null)
    setPendingId(brand?.id ?? crypto.randomUUID())
    setTouched(false)
    setFormError(null)
  }, [open, brand])

  const nameError = touched && !isNotBlank(name) ? t('products.brands.errors.nameRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(name)) return

    setSubmitting(true)
    try {
      const input = { tenant_id: tenantId, name: name.trim(), is_active: isActive, logo_url: logoUrl }
      if (brand) await updateBrand(brand.id, input)
      else await createBrand({ ...input, id: pendingId })
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('products.brands.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={brand ? t('products.brands.drawer.editTitle') : t('products.brands.drawer.newTitle')}
      description={t('products.brands.drawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="brand-name">{t('products.brands.fields.name')}</Label>
          <Input
            id="brand-name"
            value={name}
            invalid={!!nameError}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('products.brands.fields.namePlaceholder')}
          />
          <FieldError message={nameError} />
        </div>

        <div className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2.5">
          <span className="text-sm text-brand-700">{t('products.brands.fields.isActive')}</span>
          <Switch checked={isActive} onChange={setIsActive} />
        </div>

        {pendingId && (
          <BrandLogoPicker
            tenantId={tenantId}
            brandId={pendingId}
            name={name || t('products.brands.fields.name')}
            logoUrl={logoUrl}
            onUploaded={setLogoUrl}
            onRemoved={() => setLogoUrl(null)}
          />
        )}

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
            {submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
