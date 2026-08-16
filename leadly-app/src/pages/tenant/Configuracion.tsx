import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { getTenant, uploadTenantLogo, validateTenantLogoFile } from '../../lib/api/tenants'
import { createConversationTag, deleteConversationTag, listConversationTags } from '../../lib/api/conversationTags'
import type { ConversationTag, Tenant } from '../../types/domain'
import { Button, Card, CardSection, EmptyState, InitialsAvatar, Input, PageSpinner } from '../../components/ui'
import { PencilIcon, PlusIcon, XCircleIcon } from '../../components/icons'
import { Bodegas } from './Bodegas'

// One Card, divided into CardSections (same pattern as MiCuenta.tsx/
// Facturacion.tsx) instead of a separate floating Card per concern -- the
// previous version (2026-08-16) gave every section its own card with an
// icon chip + description header, which read as a tall stack of
// same-weight boxes instead of one compact profile page. Dropped the
// per-section description paragraphs too (title is enough, matches every
// other CardSection screen in the app -- none of them carry one).
export function Configuracion() {
  const { profile, enabledModules } = useAuth()
  const { t } = useLanguage()
  const isAdmin = profile?.role === 'tenant_admin'

  return (
    <Card padded={false} className="max-w-2xl">
      {isAdmin && <CompanySection />}
      {isAdmin && <TagsSection />}
      {enabledModules?.has('inventory') && (
        <CardSection title={t('inventory.warehouses.title')}>
          <Bodegas />
        </CardSection>
      )}
    </Card>
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

  return (
    <CardSection title={t('settings.logo.title')}>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!error && tenant === undefined && <PageSpinner />}
      {tenant && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={logoUploading}
            className="group relative shrink-0 rounded-full"
            aria-label={tenant.logo_url ? t('settings.logo.change') : t('settings.logo.upload')}
          >
            {tenant.logo_url ? (
              <img src={tenant.logo_url} alt="" className="h-14 w-14 rounded-full object-cover" />
            ) : (
              <InitialsAvatar name={tenant.name} size="md" />
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
      )}
      {logoError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{logoError}</p>}
    </CardSection>
  )
}

function TagsSection() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const [tags, setTags] = useState<ConversationTag[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [newTag, setNewTag] = useState('')
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  function reload() {
    if (!profile?.tenant_id) return
    listConversationTags(profile.tenant_id)
      .then(setTags)
      .catch((err) => setError(err.message ?? t('settings.tags.errors.load')))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [profile?.tenant_id])

  async function handleCreate(e: FormEvent) {
    e.preventDefault()
    const name = newTag.trim()
    if (!name || !profile?.tenant_id) return
    setCreating(true)
    setError(null)
    try {
      const tag = await createConversationTag(profile.tenant_id, name)
      setTags((prev) => (prev ? [...prev, tag].sort((a, b) => a.name.localeCompare(b.name)) : [tag]))
      setNewTag('')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.tags.errors.create'))
    } finally {
      setCreating(false)
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    setError(null)
    try {
      await deleteConversationTag(id)
      setTags((prev) => (prev ? prev.filter((t) => t.id !== id) : prev))
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.tags.errors.delete'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <CardSection title={t('settings.tags.title')}>
      {error && <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!tags && !error && <PageSpinner />}

      {tags && (
        <>
          <form onSubmit={handleCreate} className="mb-3 flex gap-2">
            <Input value={newTag} onChange={(e) => setNewTag(e.target.value)} placeholder={t('settings.tags.placeholder')} className="!py-1.5 text-sm" />
            <Button type="submit" variant="secondary" disabled={creating || !newTag.trim()} className="!px-3.5 !py-1.5 text-xs shrink-0">
              <PlusIcon width={13} height={13} /> {t('common.actions.add')}
            </Button>
          </form>

          {tags.length === 0 ? (
            <EmptyState>{t('settings.tags.empty')}</EmptyState>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <span key={tag.id} className="flex items-center gap-1.5 rounded-full bg-brand-50 py-1 pl-3 pr-1.5 text-xs font-medium text-brand-600">
                  {tag.name}
                  <button
                    type="button"
                    onClick={() => handleDelete(tag.id)}
                    disabled={deletingId === tag.id}
                    aria-label={t('settings.tags.deleteAria', { name: tag.name })}
                    className="rounded-full p-0.5 text-brand-400 transition-colors hover:bg-brand-100 hover:text-red-600 disabled:opacity-50"
                  >
                    <XCircleIcon width={13} height={13} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </CardSection>
  )
}
