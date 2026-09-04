import { useEffect, useState, type FormEvent } from 'react'
import { Copy } from 'lucide-react'
import { useLanguage } from '../../../contexts/LanguageContext'
import { STOREFRONT_SLUG_TAKEN_CODE, updateTenantStorefront } from '../../../lib/api/tenants'
import type { Tenant } from '../../../types/domain'
import { Switch } from '@/components/atoms'
import { Card, CardSection } from '@/components/molecules'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** "Tienda pública" category -- address/slug (editable), estado (switch),
 * and a single URL block with a copy button + "Ver tienda" -- shown
 * whenever a slug is saved, regardless of the enabled toggle, so the
 * tenant can preview/copy the link before flipping it on. Slug and
 * enabled each save on their own (instant-apply for the toggle, its own
 * "Guardar" for the slug) -- same as before, just repackaged as its own
 * top-level settings category instead of nesting inside the company card. */
export function StorefrontSection({ tenant, onSaved }: { tenant: Tenant; onSaved: (tenant: Tenant) => void }) {
  const { t } = useLanguage()
  const [slugInput, setSlugInput] = useState(tenant.storefront_slug ?? '')
  const [savingSlug, setSavingSlug] = useState(false)
  const [togglingEnabled, setTogglingEnabled] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    setSlugInput(tenant.storefront_slug ?? '')
  }, [tenant.storefront_slug])

  const origin = window.location.origin
  const storefrontUrl = tenant.storefront_slug ? `${origin}/tienda/${tenant.storefront_slug}` : null
  const normalizedInput = slugInput.trim().toLowerCase()
  const slugChanged = normalizedInput !== (tenant.storefront_slug ?? '')

  async function handleSaveSlug(e: FormEvent) {
    e.preventDefault()
    if (!normalizedInput) {
      setError(t('settings.storefront.errors.slugRequired'))
      return
    }
    if (!/^[a-z0-9-]+$/.test(normalizedInput)) {
      setError(t('settings.storefront.errors.slugFormat'))
      return
    }
    setError(null)
    setSavingSlug(true)
    try {
      const updated = await updateTenantStorefront(tenant.id, { storefront_slug: normalizedInput })
      onSaved(updated)
    } catch (err) {
      const code = (err as { code?: string })?.code
      setError(
        code === STOREFRONT_SLUG_TAKEN_CODE
          ? t('settings.storefront.errors.slugTaken')
          : err instanceof Error
            ? err.message
            : t('settings.storefront.errors.save'),
      )
    } finally {
      setSavingSlug(false)
    }
  }

  async function handleToggleEnabled(enabled: boolean) {
    setTogglingEnabled(true)
    setError(null)
    try {
      const updated = await updateTenantStorefront(tenant.id, { storefront_enabled: enabled })
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.storefront.errors.save'))
    } finally {
      setTogglingEnabled(false)
    }
  }

  async function handleCopy() {
    if (!storefrontUrl) return
    await navigator.clipboard.writeText(storefrontUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Card padded={false}>
      <CardSection title={t('settings.storefront.title')} description={t('settings.storefront.description')}>
        <div className="space-y-4">
          <form onSubmit={handleSaveSlug} className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1">
              <label htmlFor="storefront-slug" className="text-xs text-brand-400">
                {t('settings.storefront.slugLabel')}
              </label>
              <div className="mt-1 flex min-w-0 items-center gap-1 rounded-lg border border-brand-200 bg-white px-2.5 py-2 focus-within:border-accent-400">
                <span className="shrink-0 text-xs text-brand-300">{origin}/tienda/</span>
                <input
                  id="storefront-slug"
                  value={slugInput}
                  onChange={(e) => setSlugInput(e.target.value)}
                  placeholder={t('settings.storefront.slugPlaceholder')}
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm text-brand-800 outline-none"
                />
              </div>
            </div>
            <Button type="submit" size="sm" disabled={savingSlug || !slugChanged}>
              {savingSlug ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
          </form>
          <p className="-mt-2 text-[11px] text-brand-300">{t('settings.storefront.slugHint')}</p>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="flex items-center justify-between gap-3 border-t border-brand-100 pt-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-brand-700">{t('settings.storefront.enabledLabel')}</p>
              <p className="text-xs text-brand-400">{t('settings.storefront.enabledDescription')}</p>
            </div>
            <Switch checked={tenant.storefront_enabled} disabled={togglingEnabled || !tenant.storefront_slug} onChange={handleToggleEnabled} />
          </div>

          {storefrontUrl && (
            <div className="border-t border-brand-100 pt-4">
              <div className="flex flex-wrap items-center gap-2">
                <Input readOnly value={storefrontUrl} className="min-w-0 flex-1 text-xs" onFocus={(e) => e.target.select()} />
                <Button type="button" variant="secondary" size="icon-sm" onClick={handleCopy} aria-label={t('settings.storefront.copyAria')}>
                  <Copy className="size-3.5" />
                </Button>
                <a href={storefrontUrl} target="_blank" rel="noreferrer">
                  <Button type="button" variant="outline" size="sm">
                    {t('settings.storefront.view')}
                  </Button>
                </a>
              </div>
              {copied && <p className="mt-1.5 text-[11px] text-emerald-600">{t('settings.storefront.copied')}</p>}
            </div>
          )}
        </div>
      </CardSection>
    </Card>
  )
}
