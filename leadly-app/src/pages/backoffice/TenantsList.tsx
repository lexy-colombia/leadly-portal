import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { listTenants } from '../../lib/api/tenants'
import type { Tenant, TenantEntityType, TenantStatus } from '../../types/domain'
import { Badge, Button, InitialsAvatar, PageSpinner, Select, Table, TBody, TD, TH, THead, TRow } from '@/components/atoms'
import { Card, EmptyState, IconInput, Pagination } from '@/components/molecules'
import { FilterIcon, PlusIcon, SearchIcon } from '@/components/atoms/icons'
import { TenantDrawer } from './TenantDrawer'
import { useLanguage } from '../../contexts/LanguageContext'

const PAGE_SIZE = 10

export function TenantsList() {
  const { t, language } = useLanguage()
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
                <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TenantStatus | '')} className="!py-1.5 text-sm">
                  <option value="">{t('backoffice.clientesList.filters.status.all')}</option>
                  <option value="active">{t('common.status.active')}</option>
                  <option value="inactive">{t('common.status.inactive')}</option>
                </Select>
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('backoffice.clientesList.filters.entityType.label')}</label>
                <Select value={entityFilter} onChange={(e) => setEntityFilter(e.target.value as TenantEntityType | '')} className="!py-1.5 text-sm">
                  <option value="">{t('backoffice.clientesList.filters.entityType.all')}</option>
                  <option value="empresa">{t('backoffice.clienteDetalle.entityType.empresa')}</option>
                  <option value="persona">{t('backoffice.clienteDetalle.entityType.persona')}</option>
                </Select>
              </div>
              {allCountries.length > 0 && (
                <div>
                  <label className="mb-1 block text-xs font-medium text-brand-400">{t('backoffice.clientesList.filters.country.label')}</label>
                  <Select value={countryFilter} onChange={(e) => setCountryFilter(e.target.value)} className="!py-1.5 text-sm">
                    <option value="">{t('backoffice.clientesList.filters.country.all')}</option>
                    {allCountries.map((country) => (
                      <option key={country} value={country}>
                        {country}
                      </option>
                    ))}
                  </Select>
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

        <Button variant="secondary" onClick={() => setDrawerOpen(true)} className="!ml-auto !py-1.5 !text-sm">
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
          <Table>
            <THead>
              <tr>
                <TH>{t('backoffice.clientesList.table.name')}</TH>
                <TH>{t('backoffice.clientesList.table.status')}</TH>
                <TH className="hidden sm:table-cell">{t('backoffice.clientesList.table.contact')}</TH>
                <TH className="hidden md:table-cell">{t('backoffice.clientesList.table.country')}</TH>
                <TH className="hidden md:table-cell">{t('backoffice.clientesList.table.created')}</TH>
              </tr>
            </THead>
            <TBody>
              {pageItems.map((tenant) => (
                <TRow key={tenant.id} clickable>
                  <TD>
                    <Link to={`/backoffice/clientes/${tenant.id}`} className="flex items-center gap-3 font-medium text-brand-800 hover:text-accent-600">
                      {tenant.logo_url ? (
                        <img src={tenant.logo_url} alt="" className="h-8 w-8 rounded-full object-cover" />
                      ) : (
                        <InitialsAvatar name={tenant.name} size="sm" />
                      )}
                      {tenant.name}
                    </Link>
                  </TD>
                  <TD>
                    <Badge tone={tenant.status === 'active' ? 'success' : 'neutral'}>
                      {tenant.status === 'active' ? t('common.status.active') : t('common.status.inactive')}
                    </Badge>
                  </TD>
                  <TD className="hidden sm:table-cell text-brand-400">{tenant.contact_email ?? '—'}</TD>
                  <TD className="hidden md:table-cell text-brand-400">{tenant.country ?? '—'}</TD>
                  <TD className="hidden md:table-cell text-brand-400">
                    {new Date(tenant.created_at).toLocaleDateString(language === 'en' ? 'en-US' : 'es-CO')}
                  </TD>
                </TRow>
              ))}
            </TBody>
          </Table>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <TenantDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onSaved={reload} />
    </div>
  )
}
