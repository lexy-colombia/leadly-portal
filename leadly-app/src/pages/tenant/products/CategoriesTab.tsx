import { useEffect, useState } from 'react'
import { deleteProductCategory, listProductCategories } from '../../../lib/api/productCategories'
import type { ProductCategory } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Button, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { CategoryDrawer } from './CategoryDrawer'

const PAGE_SIZE = 10

export function CategoriesTab({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [categories, setCategories] = useState<ProductCategory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; category: ProductCategory | null }>({ open: false, category: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    listProductCategories(tenantId)
      .then(setCategories)
      .catch((err) => setError(err.message ?? t('products.categories.errors.load')))
  }

  useEffect(reload, [tenantId])

  const totalPages = categories ? Math.max(1, Math.ceil(categories.length / PAGE_SIZE)) : 1
  const pageItems = categories ? categories.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteProductCategory(id)
      setCategories((prev) => (prev ? prev.filter((c) => c.id !== id) : prev))
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.categories.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-brand-400">
          {categories?.length ?? 0} {t((categories?.length ?? 0) === 1 ? 'products.categories.count.singular' : 'products.categories.count.plural')}
        </span>
        <Button variant="secondary" onClick={() => setDrawer({ open: true, category: null })} className="!ml-auto !py-1 !text-xs">
          <PlusIcon width={14} height={14} /> {t('products.categories.actions.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!categories && !error && <PageSpinner />}

      {categories && categories.length === 0 && (
        <Card>
          <EmptyState>{t('products.categories.empty')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <Table>
            <THead>
              <tr>
                <TH>{t('products.categories.table.category')}</TH>
                <TH>{t('products.categories.table.description')}</TH>
                <TH className="text-right">{t('products.categories.table.actions')}</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((category) => (
                <TRow key={category.id}>
                  <TD className="text-xs font-medium text-brand-800">
                    <span className="inline-flex items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: category.color ?? '#94A3B8' }} />
                      {category.name}
                    </span>
                  </TD>
                  <TD className="text-xs text-brand-500">{category.description ?? '-'}</TD>
                  <TD className="text-right">
                    {deletingId === category.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="danger" onClick={() => handleDelete(category.id)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {t('common.actions.cancel')}
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Button variant="ghost" onClick={() => setDrawer({ open: true, category })} className="!px-2 !py-1 text-xs">
                          <PencilIcon width={12} height={12} />
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(category.id)} className="!px-2 !py-1 text-xs !text-red-600 hover:!bg-red-50">
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

      <CategoryDrawer open={drawer.open} onClose={() => setDrawer({ open: false, category: null })} tenantId={tenantId} category={drawer.category} onSaved={reload} />
    </div>
  )
}
