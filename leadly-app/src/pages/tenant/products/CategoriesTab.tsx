import { useEffect, useState } from 'react'
import { deleteProductCategory, flattenCategoryTree, listProductCategories, updateProductCategory } from '../../../lib/api/productCategories'
import type { ProductCategory } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CategoryDrawer } from './CategoryDrawer'

// No pagination here (unlike every other list in the app, see the project's
// "all lists paginated" rule) -- a flattened tree loses its parent/child
// grouping if a page boundary lands mid-subtree, and a tenant's category
// tree realistically never gets deep enough to need it.
function formatDate(iso: string, locale: string): string {
  return new Date(iso).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function CategoriesTab({ tenantId }: { tenantId: string }) {
  const { t, language } = useLanguage()
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  const [categories, setCategories] = useState<ProductCategory[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ open: boolean; category: ProductCategory | null; parentId: string | null }>({
    open: false,
    category: null,
    parentId: null,
  })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  function reload() {
    listProductCategories(tenantId)
      .then(setCategories)
      .catch((err) => setError(err.message ?? t('products.categories.errors.load')))
  }

  useEffect(reload, [tenantId])

  const tree = categories ? flattenCategoryTree(categories) : null

  async function handleToggleActive(category: ProductCategory, checked: boolean) {
    setTogglingId(category.id)
    setCategories((list) => (list ? list.map((c) => (c.id === category.id ? { ...c, is_active: checked } : c)) : list))
    try {
      await updateProductCategory(category.id, { is_active: checked })
    } catch (err) {
      setCategories((list) => (list ? list.map((c) => (c.id === category.id ? { ...c, is_active: !checked } : c)) : list))
      setError(err instanceof Error ? err.message : t('products.categories.errors.save'))
    } finally {
      setTogglingId(null)
    }
  }

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
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-brand-400">
          {categories?.length ?? 0} {t((categories?.length ?? 0) === 1 ? 'products.categories.count.singular' : 'products.categories.count.plural')}
        </span>
        <Button onClick={() => setDrawer({ open: true, category: null, parentId: null })} size="sm" className="ml-auto">
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

      {tree && tree.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('products.categories.table.category')}</TableHead>
                <TableHead>{t('products.categories.table.description')}</TableHead>
                <TableHead>{t('products.categories.table.status')}</TableHead>
                <TableHead>{t('products.categories.table.createdAt')}</TableHead>
                <TableHead className="text-right">{t('products.categories.table.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tree.map(({ category, depth }) => (
                <TableRow key={category.id} className={!category.is_active ? 'opacity-60' : undefined}>
                  <TableCell className="text-xs font-medium text-brand-800">
                    <span className="flex items-center gap-2" style={{ paddingLeft: `${depth * 20}px` }}>
                      {depth > 0 && <span className="text-brand-300">└</span>}
                      <span className={depth > 0 ? 'font-normal text-brand-600' : 'font-semibold'}>{category.name}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-brand-500">{category.description || '—'}</TableCell>
                  <TableCell>
                    <Switch
                      checked={category.is_active}
                      disabled={togglingId === category.id}
                      onCheckedChange={(checked) => handleToggleActive(category, checked)}
                      aria-label={t(category.is_active ? 'common.status.active' : 'common.status.inactive')}
                    />
                  </TableCell>
                  <TableCell className="text-xs text-brand-500">{formatDate(category.created_at, locale)}</TableCell>
                  <TableCell className="text-right">
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
                        <Button variant="ghost" size="icon-xs" title={t('products.categories.actions.newSubcategory')} onClick={() => setDrawer({ open: true, category: null, parentId: category.id })}>
                          <PlusIcon width={12} height={12} />
                        </Button>
                        <Button variant="ghost" size="icon-xs" onClick={() => setDrawer({ open: true, category, parentId: null })}>
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
      )}

      <CategoryDrawer
        open={drawer.open}
        onClose={() => setDrawer({ open: false, category: null, parentId: null })}
        tenantId={tenantId}
        category={drawer.category}
        defaultParentId={drawer.parentId}
        allCategories={categories ?? []}
        onSaved={reload}
      />
    </div>
  )
}
