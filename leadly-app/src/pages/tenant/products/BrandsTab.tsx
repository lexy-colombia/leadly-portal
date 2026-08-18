import { useEffect, useState } from 'react'
import { deleteBrand, listBrands } from '../../../lib/api/brands'
import type { Brand } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Badge, Button, InitialsAvatar, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
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
        <Button variant="secondary" onClick={() => setDrawer({ open: true, brand: null })} className="!ml-auto !py-1 !text-xs">
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
          <Table>
            <THead>
              <tr>
                <TH>{t('products.brands.table.brand')}</TH>
                <TH>{t('products.brands.table.status')}</TH>
                <TH className="text-right">{t('products.brands.table.actions')}</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((brand) => (
                <TRow key={brand.id}>
                  <TD className="text-xs font-medium text-brand-800">
                    <span className="flex items-center gap-2.5">
                      {brand.logo_url ? (
                        <img src={brand.logo_url} alt="" className="h-7 w-7 rounded-full object-cover" />
                      ) : (
                        <InitialsAvatar name={brand.name} size="sm" />
                      )}
                      {brand.name}
                    </span>
                  </TD>
                  <TD>
                    <Badge tone={brand.is_active ? 'success' : 'neutral'}>{t(brand.is_active ? 'common.status.active' : 'common.status.inactive')}</Badge>
                  </TD>
                  <TD className="text-right">
                    {deletingId === brand.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="danger" onClick={() => handleDelete(brand.id)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {t('common.actions.cancel')}
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Button variant="ghost" onClick={() => setDrawer({ open: true, brand })} className="!px-2 !py-1 text-xs">
                          <PencilIcon width={12} height={12} />
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(brand.id)} className="!px-2 !py-1 text-xs !text-red-600 hover:!bg-red-50">
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

      <BrandDrawer open={drawer.open} onClose={() => setDrawer({ open: false, brand: null })} tenantId={tenantId} brand={drawer.brand} onSaved={reload} />
    </div>
  )
}
