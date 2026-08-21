import { useEffect, useState } from 'react'
import { deleteBrand, listBrands, updateBrand } from '../../../lib/api/brands'
import type { Brand } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { formatDate } from '../../../lib/dates'
import { InitialsAvatar, PageSpinner } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { BrandDrawer } from './BrandDrawer'

const PAGE_SIZE = 10

export function BrandsTab({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [brands, setBrands] = useState<Brand[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; brand: Brand | null }>({ open: false, brand: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  function reload() {
    listBrands(tenantId)
      .then((data) => {
        setBrands(data)
        // Keeps an open edit drawer in sync (e.g. right after a logo upload) --
        // the drawer's `brand` prop is separate state from this list, so a
        // plain reload alone wouldn't reach it. Same pattern as Products.tsx.
        setDrawer((prev) => (prev.brand ? { ...prev, brand: data.find((b) => b.id === prev.brand!.id) ?? prev.brand } : prev))
      })
      .catch((err) => setError(err.message ?? t('products.brands.errors.load')))
  }

  useEffect(reload, [tenantId])

  const totalPages = brands ? Math.max(1, Math.ceil(brands.length / PAGE_SIZE)) : 1
  const pageItems = brands ? brands.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleToggleActive(brand: Brand, checked: boolean) {
    setTogglingId(brand.id)
    setBrands((list) => (list ? list.map((b) => (b.id === brand.id ? { ...b, is_active: checked } : b)) : list))
    try {
      await updateBrand(brand.id, { is_active: checked })
    } catch (err) {
      setBrands((list) => (list ? list.map((b) => (b.id === brand.id ? { ...b, is_active: !checked } : b)) : list))
      setError(err instanceof Error ? err.message : t('products.brands.errors.save'))
    } finally {
      setTogglingId(null)
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteBrand(id)
      setBrands((prev) => (prev ? prev.filter((b) => b.id !== id) : prev))
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('products.brands.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-brand-400">
          {brands?.length ?? 0} {t((brands?.length ?? 0) === 1 ? 'products.brands.count.singular' : 'products.brands.count.plural')}
        </span>
        <Button onClick={() => setDrawer({ open: true, brand: null })} size="sm" className="ml-auto">
          <PlusIcon width={14} height={14} /> {t('products.brands.actions.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!brands && !error && <PageSpinner />}

      {brands && brands.length === 0 && (
        <Card>
          <EmptyState>{t('products.brands.empty')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('products.brands.table.brand')}</TableHead>
                  <TableHead>{t('products.brands.table.description')}</TableHead>
                  <TableHead>{t('products.brands.table.status')}</TableHead>
                  <TableHead>{t('products.brands.table.createdAt')}</TableHead>
                  <TableHead className="text-right">{t('products.brands.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((brand) => (
                  <TableRow key={brand.id} onClick={() => setDrawer({ open: true, brand })} className="cursor-pointer">
                    <TableCell className="text-xs font-medium text-brand-800">
                      <span className="flex items-center gap-2.5">
                        {brand.logo_url ? (
                          <img src={brand.logo_url} alt="" className="h-7 w-7 rounded-full object-cover" />
                        ) : (
                          <InitialsAvatar name={brand.name} size="sm" />
                        )}
                        {brand.name}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs text-brand-500">{brand.description || '—'}</TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Switch
                        checked={brand.is_active}
                        disabled={togglingId === brand.id}
                        onCheckedChange={(checked) => handleToggleActive(brand, checked)}
                        aria-label={t(brand.is_active ? 'common.status.active' : 'common.status.inactive')}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-brand-500">{formatDate(brand.created_at)}</TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {deletingId === brand.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Button variant="destructive" size="xs" onClick={() => handleDelete(brand.id)} disabled={deleting}>
                            {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => setDeletingId(null)} disabled={deleting}>
                            {t('common.actions.cancel')}
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Button variant="ghost" size="icon-xs" onClick={() => setDrawer({ open: true, brand })}>
                            <PencilIcon width={12} height={12} />
                          </Button>
                          <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" onClick={() => setDeletingId(brand.id)}>
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

      <BrandDrawer open={drawer.open} onClose={() => setDrawer({ open: false, brand: null })} tenantId={tenantId} brand={drawer.brand} onSaved={reload} />
    </div>
  )
}
