import { useEffect, useState } from 'react'
import { deleteSupplier, listSuppliers, updateSupplier } from '../../../lib/api/suppliers'
import type { Supplier } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
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
  const [togglingId, setTogglingId] = useState<string | null>(null)

  function reload() {
    listSuppliers(tenantId)
      .then(setSuppliers)
      .catch((err) => setError(err.message ?? t('products.suppliers.errors.load')))
  }

  useEffect(reload, [tenantId])

  const totalPages = suppliers ? Math.max(1, Math.ceil(suppliers.length / PAGE_SIZE)) : 1
  const pageItems = suppliers ? suppliers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleToggleActive(supplier: Supplier, checked: boolean) {
    setTogglingId(supplier.id)
    setSuppliers((list) => (list ? list.map((s) => (s.id === supplier.id ? { ...s, is_active: checked } : s)) : list))
    try {
      await updateSupplier(supplier.id, { is_active: checked })
    } catch (err) {
      setSuppliers((list) => (list ? list.map((s) => (s.id === supplier.id ? { ...s, is_active: !checked } : s)) : list))
      setError(err instanceof Error ? err.message : t('products.suppliers.errors.save'))
    } finally {
      setTogglingId(null)
    }
  }

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
        <Button onClick={() => setDrawer({ open: true, supplier: null })} size="sm" className="ml-auto">
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
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('products.suppliers.table.supplier')}</TableHead>
                  <TableHead>{t('products.suppliers.table.contact')}</TableHead>
                  <TableHead>{t('products.suppliers.table.phone')}</TableHead>
                  <TableHead>{t('products.suppliers.table.status')}</TableHead>
                  <TableHead className="text-right">{t('products.suppliers.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((supplier) => (
                  <TableRow key={supplier.id} onClick={() => setDrawer({ open: true, supplier })} className="cursor-pointer">
                    <TableCell className="text-xs font-medium text-brand-800">{supplier.name}</TableCell>
                    <TableCell className="text-xs text-brand-500">{supplier.contact_name ?? '-'}</TableCell>
                    <TableCell className="text-xs text-brand-500">{supplier.phone ?? '-'}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={supplier.is_active}
                        disabled={togglingId === supplier.id}
                        onCheckedChange={(checked) => handleToggleActive(supplier, checked)}
                        aria-label={t(supplier.is_active ? 'common.status.active' : 'common.status.inactive')}
                      />
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {deletingId === supplier.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Button variant="destructive" size="xs" onClick={() => handleDelete(supplier.id)} disabled={deleting}>
                            {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => setDeletingId(null)} disabled={deleting}>
                            {t('common.actions.cancel')}
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Button variant="ghost" size="icon-xs" onClick={() => setDrawer({ open: true, supplier })}>
                            <PencilIcon width={12} height={12} />
                          </Button>
                          <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" onClick={() => setDeletingId(supplier.id)}>
                            <TrashIcon width={12} height={12} />
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <SupplierDrawer open={drawer.open} onClose={() => setDrawer({ open: false, supplier: null })} tenantId={tenantId} supplier={drawer.supplier} onSaved={reload} />
    </div>
  )
}
