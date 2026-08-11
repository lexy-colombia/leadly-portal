import { useEffect, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { getTenant, uploadTenantLogo, validateTenantLogoFile } from '../../lib/api/tenants'
import { createConversationTag, deleteConversationTag, listConversationTags } from '../../lib/api/conversationTags'
import type { ConversationTag, Tenant } from '../../types/domain'
import { Button, Card, EmptyState, InitialsAvatar, Input, PageSpinner } from '../../components/ui'
import { BuildingIcon, PlusIcon, TagIcon, XCircleIcon } from '../../components/icons'

/** Every section header here follows the same shape (icon chip + title + one-line
 * description), and at most one accent-filled button per Card -- everything else is
 * `ghost`. Previously three sections lived stacked in one shared Card with a button
 * in every header, which read as a wall of same-weight buttons with no clear "this is
 * the one thing to click here" per section. Separate Cards + one clear CTA each fixes that. */
function SectionHeader({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-500">{icon}</span>
        <div>
          <h2 className="font-semibold text-brand-800">{title}</h2>
          <p className="text-sm text-brand-400">{description}</p>
        </div>
      </div>
      {action}
    </div>
  )
}

export function Configuracion() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'tenant_admin'

  return (
    <div className="space-y-4">
      {isAdmin && <LogoSection />}
      {isAdmin && <TagsSection />}
    </div>
  )
}

function LogoSection() {
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
    <Card>
      <SectionHeader icon={<BuildingIcon width={18} height={18} />} title={t('settings.logo.title')} description={t('settings.logo.description')} />

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!error && tenant === undefined && <PageSpinner />}
      {tenant && (
        <div className="flex items-center gap-4">
          {tenant.logo_url ? (
            <img src={tenant.logo_url} alt="" className="h-16 w-16 shrink-0 rounded-full object-cover" />
          ) : (
            <InitialsAvatar name={tenant.name} size="lg" />
          )}
          <div>
            <Button type="button" variant="ghost" onClick={() => fileInputRef.current?.click()} disabled={logoUploading} className="!px-3.5 !py-2 text-xs">
              {logoUploading ? t('settings.logo.uploading') : tenant.logo_url ? t('settings.logo.change') : t('settings.logo.upload')}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/svg+xml"
              className="hidden"
              onChange={handleLogoPick}
            />
            <p className="mt-1.5 text-xs text-brand-400">{t('settings.logo.hint')}</p>
          </div>
        </div>
      )}
      {logoError && <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{logoError}</p>}
    </Card>
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
    <Card>
      <SectionHeader icon={<TagIcon width={18} height={18} />} title={t('settings.tags.title')} description={t('settings.tags.description')} />

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
    </Card>
  )
}
