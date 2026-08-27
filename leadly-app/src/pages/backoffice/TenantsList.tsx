import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { listTenants } from '../../lib/api/tenants'
import type { Tenant, TenantEntityType, TenantStatus } from '../../types/domain'
import { InitialsAvatar, PageSpinner } from '@/components/atoms'
import { Card, ComboboxFilter, EmptyState, IconInput, Pagination } from '@/components/molecules'
import { FilterIcon, PlusIcon, SearchIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { TenantDrawer } from './TenantDrawer'
import { useLanguage } from '../../contexts/LanguageContext'
import { formatDate } from '../../lib/dates'

// bg/text pair on top of shadcn Badge's `outline` variant, same convention
// as Clients.tsx's STAGE_BADGE_CLASS -- shadcn's own variants have no
// "success"/"neutral" tone, unlike the legacy atoms Badge this replaces.
const TENANT_STATUS_BADGE_CLASS: Record<TenantStatus, string> = {
  active: 'border-transparent bg-emerald-100 text-emerald-700',
  inactive: 'border-transparent bg-slate-100 text-slate-600',
}

const PAGE_SIZE = 10

export function TenantsList() {
  const { t } = useLanguage()
  const navigate = useNavigate()
  const [tenants, setTenants] = useState<Tenant[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<TenantStatus | ''>('')
  const [entityFilter, setEntityFilter] = useState<TenantEntityType | ''>('')
  const [countryFilter, setCountryFilter] = useState('')
  const [page, setPage] = useState(1)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersRef = useRef<HTMLDivElement>(null)

  function reload() {
    listTenants()
      .then(setTenants)
      .catch((err) => setError(err.message ?? t('backoffice.clientesList.errors.load')))
  }

  useEffect(reload, [])

  useEffect(() => {
    if (!filtersOpen) return
    function handleClick(e: MouseEvent) {
      if (filtersRef.current && !filtersRef.current.contains(e.target as Node)) setFiltersOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [filtersOpen])

  const allCountries = useMemo(() => {
    if (!tenants) return []
    return Array.from(new Set(tenants.map((t) => t.country).filter((c): c is string => !!c))).sort()
  }, [tenants])

  const filtered = useMemo(() => {
    if (!tenants) return null
    const term = search.trim().toLowerCase()
    return tenants.filter((tenant) => {
      if (statusFilter && tenant.status !== statusFilter) return false
      if (entityFilter && tenant.entity_type !== entityFilter) return false
      if (countryFilter && tenant.country !== countryFilter) return false
      if (!term) return true
      return (
        tenant.name.toLowerCase().includes(term) ||
        tenant.legal_name?.toLowerCase().includes(term) ||
        tenant.contact_email?.toLowerCase().includes(term) ||
        tenant.contact_phone?.toLowerCase().includes(term) ||
        tenant.document_number?.toLowerCase().includes(term)
      )
    })
  }, [tenants, search, statusFilter, entityFilter, countryFilter])

  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, entityFilter, countryFilter])

  const totalPages = filtered ? Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)) : 1
  const pageItems = filtered ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  const hasActiveFilters = !!search || !!statusFilter || !!entityFilter || !!countryFilter

  return (
    <div className="animate-fade-in space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-full max-w-[220px] sm:w-auto">
          <IconInput
            icon={<SearchIcon width={14} height={14} />}
            placeholder={t('backoffice.clientesList.search.placeholder')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="!py-1.5 !pl-8 text-sm"
          />
        </div>

        <div ref={filtersRef} className="relative">
          <button
            type="button"
            onClick={() => setFiltersOpen((o) => !o)}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              hasActiveFilters ? 'border-accent-300 bg-accent-50 text-accent-700' : 'border-brand-200 text-brand-600 hover:bg-brand-50'
            }`}
          >
            <FilterIcon width={14} height={14} />
            {t('backoffice.clientesList.filters.label')}
            {hasActiveFilters && <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />}
          </button>

          {filtersOpen && (
            <div className="absolute left-0 top-full z-40 mt-2 w-64 max-w-[calc(100vw-2rem)] space-y-3 rounded-2xl border border-brand-100 bg-white p-4 shadow-lg">
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('backoffice.clientesList.filters.status.label')}</label>
                <ComboboxFilter
                  options={[
                    { id: 'active', label: t('common.status.active') },
                    { id: 'inactive', label: t('common.status.inactive') },
                  ]}
                  value={statusFilter || null}
                  onChange={(id) => setStatusFilter((id as TenantStatus) ?? '')}
                  placeholder={t('backoffice.clientesList.filters.status.all')}
                  searchPlaceholder={t('backoffice.clientesList.filters.search')}
                  emptyLabel={t('backoffice.clientesList.filters.noResults')}
                  triggerClassName="w-full"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('backoffice.clientesList.filters.entityType.label')}</label>
                <ComboboxFilter
                  options={[
                    { id: 'empresa', label: t('backoffice.clienteDetalle.entityType.empresa') },
                    { id: 'persona', label: t('backoffice.clienteDetalle.entityType.persona') },
                  ]}
                  value={entityFilter || null}
                  onChange={(id) => setEntityFilter((id as TenantEntityType) ?? '')}
                  placeholder={t('backoffice.clientesList.filters.entityType.all')}
                  searchPlaceholder={t('backoffice.clientesList.filters.search')}
                  emptyLabel={t('backoffice.clientesList.filters.noResults')}
                  triggerClassName="w-full"
                />
              </div>
              {allCountries.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-brand-400">{t('backoffice.clientesList.filters.country.label')}</label>
                  <ComboboxFilter
                    options={allCountries.map((country) => ({ id: country, label: country }))}
                    value={countryFilter || null}
                    onChange={(id) => setCountryFilter(id ?? '')}
                    placeholder={t('backoffice.clientesList.filters.country.all')}
                    searchPlaceholder={t('backoffice.clientesList.filters.search')}
                    emptyLabel={t('backoffice.clientesList.filters.noResults')}
                    triggerClassName="w-full"
                  />
                </div>
              )}
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={() => {
                    setSearch('')
                    setStatusFilter('')
                    setEntityFilter('')
                    setCountryFilter('')
                  }}
                  className="text-xs font-medium text-brand-400 hover:text-brand-700"
                >
                  {t('backoffice.clientesList.filters.clear')}
                </button>
              )}
            </div>
          )}
        </div>

        <span className="shrink-0 text-xs text-brand-400">
          {filtered?.length ?? 0}{' '}
          {t((filtered?.length ?? 0) === 1 ? 'backoffice.clientesList.count.singular' : 'backoffice.clientesList.count.plural')}
        </span>

        <Button variant="secondary" size="sm" onClick={() => setDrawerOpen(true)} className="ml-auto">
          <PlusIcon width={16} height={16} /> {t('backoffice.clientesList.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!tenants && !error && <PageSpinner />}

      {filtered && filtered.length === 0 && (
        <Card>
          <EmptyState>
            {tenants && tenants.length > 0 ? t('backoffice.clientesList.emptyState.noMatch') : t('backoffice.clientesList.empty')}
          </EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('backoffice.clientesList.table.name')}</TableHead>
                  <TableHead>{t('backoffice.clientesList.table.status')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('backoffice.clientesList.table.contact')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('backoffice.clientesList.table.country')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('backoffice.clientesList.table.created')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((tenant) => (
                  <TableRow key={tenant.id} onClick={() => navigate(`/backoffice/clients/${tenant.id}`)} className="cursor-pointer">
                    <TableCell>
                      <span className="flex items-center gap-3 font-medium text-brand-800">
                        {tenant.logo_url ? (
                          <img src={tenant.logo_url} alt="" className="h-8 w-8 rounded-full object-cover" />
                        ) : (
                          <InitialsAvatar name={tenant.name} size="sm" />
                        )}
                        {tenant.name}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={TENANT_STATUS_BADGE_CLASS[tenant.status]}>
                        {tenant.status === 'active' ? t('common.status.active') : t('common.status.inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-brand-400">{tenant.contact_email ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell text-brand-400">{tenant.country ?? '—'}</TableCell>
                    <TableCell className="hidden md:table-cell text-brand-400">
                      {formatDate(tenant.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <TenantDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onSaved={reload} />
    </div>
  )
}
