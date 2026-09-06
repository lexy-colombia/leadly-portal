import { useEffect, useState } from 'react'
import { deleteExpenseCategory, listExpenseCategories } from '../../../lib/api/expenseCategories'
import type { ExpenseCategory } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CategoryDrawer } from './CategoryDrawer'

const PAGE_SIZE = 10

export function CategoriesTab({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [categories, setCategories] = useState<ExpenseCategory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; category: ExpenseCategory | null }>({ open: false, category: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    listExpenseCategories(tenantId)
      .then(setCategories)
      .catch((err) => setError(err.message ?? t('expenses.categories.errors.load')))
  }

  useEffect(reload, [tenantId])

  const totalPages = categories ? Math.max(1, Math.ceil(categories.length / PAGE_SIZE)) : 1
  const pageItems = categories ? categories.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteExpenseCategory(id)
      setCategories((prev) => (prev ? prev.filter((c) => c.id !== id) : prev))
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('expenses.categories.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-brand-400">
          {categories?.length ?? 0} {t((categories?.length ?? 0) === 1 ? 'expenses.categories.count.singular' : 'expenses.categories.count.plural')}
        </span>
        <Button onClick={() => setDrawer({ open: true, category: null })} size="sm" className="ml-auto">
          <PlusIcon width={14} height={14} /> {t('expenses.categories.actions.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {!categories && !error && <PageSpinner />}

      {categories && categories.length === 0 && (
        <Card>
          <EmptyState>{t('expenses.categories.empty')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('expenses.categories.table.name')}</TableHead>
                  <TableHead>{t('expenses.categories.table.description')}</TableHead>
                  <TableHead className="text-right">{t('expenses.categories.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((category) => (
                  <TableRow key={category.id} onClick={() => setDrawer({ open: true, category })} className="cursor-pointer">
                    <TableCell className="text-xs font-medium text-brand-800">{category.name}</TableCell>
                    <TableCell className="text-xs text-brand-500">{category.description || '—'}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {deletingId === category.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Button variant="destructive" size="xs" onClick={() => handleDelete(category.id)} disabled={deleting}>
                            {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => setDeletingId(null)} disabled={deleting}>
                            {t('common.actions.cancel')}
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Button variant="ghost" size="icon-xs" onClick={() => setDrawer({ open: true, category })}>
                            <PencilIcon width={12} height={12} />
                          </Button>
                          <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" onClick={() => setDeletingId(category.id)}>
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

      <CategoryDrawer open={drawer.open} onClose={() => setDrawer({ open: false, category: null })} tenantId={tenantId} category={drawer.category} onSaved={reload} />
    </div>
  )
}
