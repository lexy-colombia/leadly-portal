import { useEffect, useState } from 'react'
import { deleteCustomFieldDefinition, listCustomFieldDefinitions } from '../../../lib/api/customFields'
import type { CustomFieldDefinition } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'
import { PageSpinner } from '@/components/atoms'
import { EmptyState, Pagination } from '@/components/molecules'
import { ConfirmDialog } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { CustomFieldDrawer } from './CustomFieldDrawer'
import { customFieldTypeKey } from './customFieldTypes'

const PAGE_SIZE = 10

/** "Campos personalizados" -- CRUD de las definiciones de campos de clientes.
 * Solo tenant_admin (Settings.tsx no ofrece la categoría a otros roles; la
 * RLS de custom_field_definitions es el límite real de escritura). */
export function CustomFieldsSection({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const toast = useToast()
  const [definitions, setDefinitions] = useState<CustomFieldDefinition[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; definition: CustomFieldDefinition | null }>({ open: false, definition: null })
  const [toDelete, setToDelete] = useState<CustomFieldDefinition | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    listCustomFieldDefinitions(tenantId, 'client', false)
      .then((rows) => {
        setDefinitions(rows)
        setError(null)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('settings.customFields.errors.load')))
  }

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  async function handleConfirmDelete() {
    if (!toDelete) return
    setDeleting(true)
    try {
      await deleteCustomFieldDefinition(toDelete.id)
      toast.success(t('settings.customFields.deleted'))
      setToDelete(null)
      reload()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.customFields.errors.delete'))
      setToDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  const totalPages = definitions ? Math.max(1, Math.ceil(definitions.length / PAGE_SIZE)) : 1
  const currentPage = Math.min(page, totalPages)
  const pageItems = definitions ? definitions.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE) : null

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-brand-400">{t('settings.customFields.hint')}</p>
        <Button type="button" size="sm" className="shrink-0" onClick={() => setDrawer({ open: true, definition: null })}>
          <PlusIcon width={13} height={13} /> {t('settings.customFields.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {!definitions && !error && <PageSpinner />}
      {definitions && definitions.length === 0 && <EmptyState>{t('settings.customFields.empty')}</EmptyState>}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="divide-y divide-brand-100 overflow-hidden rounded-2xl border border-brand-100 bg-white">
            {pageItems.map((def) => (
              <div key={def.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-xs font-medium text-brand-800">{def.name}</p>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-brand-400">
                    <span>{t(customFieldTypeKey(def.field_type))}</span>
                    {def.visible_to_ai && <span className="rounded-full bg-accent-50 px-2 py-0.5 text-[11px] text-accent-700">{t('settings.customFields.badge.ai')}</span>}
                    {!def.is_active && <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] text-brand-500">{t('settings.customFields.badge.inactive')}</span>}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="icon-xs" aria-label={t('settings.customFields.aria.edit')} onClick={() => setDrawer({ open: true, definition: def })}>
                    <PencilIcon width={12} height={12} />
                  </Button>
                  <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" aria-label={t('settings.customFields.aria.delete')} onClick={() => setToDelete(def)}>
                    <TrashIcon width={12} height={12} />
                  </Button>
                </div>
              </div>
            ))}
          </div>
          <Pagination page={currentPage} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <CustomFieldDrawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, definition: null })}
        tenantId={tenantId}
        definition={drawer.definition}
        onSaved={reload}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={handleConfirmDelete}
        title={t('settings.customFields.deleteConfirm.title')}
        description={t('settings.customFields.deleteConfirm.description', { name: toDelete?.name ?? '' })}
        loading={deleting}
      />
    </div>
  )
}
