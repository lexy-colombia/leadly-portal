import { useEffect, useState } from 'react'
import { deleteSupplier, listSuppliers } from '../../../lib/api/suppliers'
import type { Supplier } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Badge, Button, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { SupplierDrawer } from './SupplierDrawer'

const PAGE_SIZE = 10

export function SuppliersTab({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; supplier: Supplier | null }>({ open: false, supplier: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    listSuppliers(tenantId)
      .then(setSuppliers)
      .catch((err) => setError(err.message ?? t('products.suppliers.errors.load')))
  }

  useEffect(reload, [tenantId])

  const totalPages = suppliers ? Math.max(1, Math.ceil(suppliers.length / PAGE_SIZE)) : 1
  const pageItems = suppliers ? suppliers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteSupplier(id)
      setSuppliers((prev) => (prev ? prev.filter((s) => s.id !== id) : prev))
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.suppliers.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-brand-400">
          {suppliers?.length ?? 0} {t((suppliers?.length ?? 0) === 1 ? 'products.suppliers.count.singular' : 'products.suppliers.count.plural')}
        </span>
        <Button variant="secondary" onClick={() => setDrawer({ open: true, supplier: null })} className="!ml-auto !py-1 !text-xs">
          <PlusIcon width={14} height={14} /> {t('products.suppliers.actions.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!suppliers && !error && <PageSpinner />}

      {suppliers && suppliers.length === 0 && (
        <Card>
          <EmptyState>{t('products.suppliers.empty')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <TH>{t('products.suppliers.table.supplier')}</TH>
                <TH>{t('products.suppliers.table.contact')}</TH>
                <TH>{t('products.suppliers.table.phone')}</TH>
                <TH>{t('products.suppliers.table.status')}</TH>
                <TH className="text-right">{t('products.suppliers.table.actions')}</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((supplier) => (
                <TRow key={supplier.id}>
                  <TD className="text-xs font-medium text-brand-800">{supplier.name}</TD>
                  <TD className="text-xs text-brand-500">{supplier.contact_name ?? '-'}</TD>
                  <TD className="text-xs text-brand-500">{supplier.phone ?? '-'}</TD>
                  <TD>
                    <Badge tone={supplier.is_active ? 'success' : 'neutral'}>{t(supplier.is_active ? 'common.status.active' : 'common.status.inactive')}</Badge>
                  </TD>
                  <TD className="text-right">
                    {deletingId === supplier.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="danger" onClick={() => handleDelete(supplier.id)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {t('common.actions.cancel')}
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Button variant="ghost" onClick={() => setDrawer({ open: true, supplier })} className="!px-2 !py-1 text-xs">
                          <PencilIcon width={12} height={12} />
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(supplier.id)} className="!px-2 !py-1 text-xs !text-red-600 hover:!bg-red-50">
                          <TrashIcon width={12} height={12} />
                        </Button>
                      </span>
                    )}
                  </TD>
                </TRow>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <SupplierDrawer open={drawer.open} onClose={() => setDrawer({ open: false, supplier: null })} tenantId={tenantId} supplier={drawer.supplier} onSaved={reload} />
    </div>
  )
}
