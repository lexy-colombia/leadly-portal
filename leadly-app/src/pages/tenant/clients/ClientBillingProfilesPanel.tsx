import { useCallback, useEffect, useState } from 'react'
import { StarIcon } from 'lucide-react'
import { BILLING_PROFILES_PAGE_SIZE, deleteBillingProfile, listBillingProfilesPage, setDefaultBillingProfile } from '../../../lib/api/billingProfiles'
import { billingProfileMissingKeys, profileHasNoEmail } from '../../../lib/billingProfile'
import type { ClientBillingProfile } from '../../../types/domain'
import { usePermission } from '../../../contexts/AuthContext'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'
import { PageSpinner } from '@/components/atoms'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { Pagination } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { BillingProfileDrawer } from './BillingProfileDrawer'
import { BillingMissingList } from './BillingMissingList'

/** «Datos de facturación» de la ficha del cliente: perfiles fiscales con
 * paginación en el servidor. Alta/edición/eliminación/predeterminado exigen el
 * permiso `contacts.edit_billing` (solo UI hasta que exista RLS por permiso). */
export function ClientBillingProfilesPanel({
  tenantId,
  clientId,
  isWalkIn,
  onCountChange,
}: {
  tenantId: string
  clientId: string
  isWalkIn: boolean
  onCountChange?: (total: number) => void
}) {
  const { t } = useLanguage()
  const toast = useToast()
  const canEdit = usePermission('contacts.edit_billing')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<ClientBillingProfile[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [drawer, setDrawer] = useState<{ open: boolean; profile: ClientBillingProfile | null }>({ open: false, profile: null })
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const load = useCallback(
    (targetPage: number) => {
      setLoadError(false)
      listBillingProfilesPage(clientId, targetPage)
        .then(({ rows: next, total: count }) => {
          const lastPage = Math.max(1, Math.ceil(count / BILLING_PROFILES_PAGE_SIZE))
          if (targetPage > lastPage) {
            setPage(lastPage)
            return
          }
          setRows(next)
          setTotal(count)
          onCountChange?.(count)
        })
        .catch(() => {
          setRows([])
          setLoadError(true)
        })
    },
    [clientId, onCountChange],
  )

  useEffect(() => {
    load(page)
  }, [load, page])

  async function handleSetDefault(id: string) {
    try {
      await setDefaultBillingProfile(id)
      load(page)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('contacts.billingProfiles.errors.saveFailed'))
    }
  }

  async function handleDelete() {
    if (!deleteId) return
    try {
      await deleteBillingProfile(deleteId)
      setDeleteId(null)
      load(page)
    } catch (err) {
      setDeleteId(null)
      toast.error(err instanceof Error ? err.message : t('contacts.billingProfiles.errors.deleteFailed'))
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / BILLING_PROFILES_PAGE_SIZE))

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-brand-400">{isWalkIn ? t('contacts.billingProfiles.walkInHint') : t('contacts.billingProfiles.panelDescription')}</p>
        {canEdit && !isWalkIn && (
          <Button size="sm" onClick={() => setDrawer({ open: true, profile: null })}>
            <PlusIcon width={13} height={13} /> {t('contacts.billingProfiles.new')}
          </Button>
        )}
      </div>
      {!rows && <PageSpinner />}
      {loadError && <p className="py-6 text-center text-xs text-red-700">{t('contacts.billingProfiles.errors.loadFailed')}</p>}
      {rows && !loadError && rows.length === 0 && <p className="py-6 text-center text-xs text-brand-400">{t('contacts.billingProfiles.empty')}</p>}
      {rows && rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((p) => (
            <li key={p.id} className="rounded-xl border border-brand-100 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-xs font-semibold text-brand-800">{p.label}</p>
                    {p.is_default && (
                      <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-700">
                        {t('contacts.detail.addresses.default')}
                      </Badge>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-brand-700">{p.legal_name || '—'}</p>
                  <p className="text-xs text-brand-400">
                    {[p.document_number, p.email, [p.address_line1, p.city].filter(Boolean).join(', ')].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {canEdit && (
                  <div className="flex shrink-0 gap-1">
                    {!p.is_default && (
                      <Button variant="ghost" size="icon-xs" aria-label={t('contacts.billingProfiles.aria.makeDefault')} title={t('contacts.billingProfiles.aria.makeDefault')} onClick={() => handleSetDefault(p.id)}>
                        <StarIcon width={13} height={13} />
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-xs" aria-label={t('contacts.billingProfiles.aria.edit')} onClick={() => setDrawer({ open: true, profile: p })}>
                      <PencilIcon width={13} height={13} />
                    </Button>
                    <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" aria-label={t('contacts.billingProfiles.aria.delete')} onClick={() => setDeleteId(p.id)}>
                      <TrashIcon width={13} height={13} />
                    </Button>
                  </div>
                )}
              </div>
              {profileHasNoEmail(p) && <p className="mt-1 text-[11px] text-amber-700">{t('billingTo.noEmail')}</p>}
              <div className="mt-2">
                <BillingMissingList keys={billingProfileMissingKeys(p)} />
              </div>
            </li>
          ))}
        </ul>
      )}
      <Pagination page={page} totalPages={totalPages} onChange={setPage} />
      <BillingProfileDrawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, profile: null })}
        tenantId={tenantId}
        clientId={clientId}
        profile={drawer.profile}
        onSaved={() => load(page)}
      />
      <ConfirmDialog
        open={!!deleteId}
        onClose={() => setDeleteId(null)}
        onConfirm={handleDelete}
        title={t('contacts.billingProfiles.deleteConfirm.title')}
        description={
          rows?.find((p) => p.id === deleteId)?.is_default
            ? t('contacts.billingProfiles.deleteConfirm.defaultDescription')
            : t('contacts.billingProfiles.deleteConfirm.description')
        }
      />
    </>
  )
}
