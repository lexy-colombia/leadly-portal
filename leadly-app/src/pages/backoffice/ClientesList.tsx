import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { listTenants } from '../../lib/api/tenants'
import type { Tenant } from '../../types/domain'
import { Badge, Button, EmptyState, InitialsAvatar, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'
import { PlusIcon } from '../../components/icons'
import { TenantDrawer } from './TenantDrawer'
import { useLanguage } from '../../contexts/LanguageContext'

export function ClientesList() {
  const { t, language } = useLanguage()
  const [tenants, setTenants] = useState<Tenant[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)

  function reload() {
    listTenants()
      .then(setTenants)
      .catch((err) => setError(err.message ?? t('backoffice.clientesList.errors.load')))
  }

  useEffect(reload, [])

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-3">
        <Button variant="secondary" onClick={() => setDrawerOpen(true)}>
          <PlusIcon width={16} height={16} /> {t('backoffice.clientesList.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!tenants && !error && <PageSpinner />}

      {tenants && tenants.length === 0 && (
        <Table>
          <TBody>
            <tr>
              <td>
                <EmptyState>{t('backoffice.clientesList.empty')}</EmptyState>
              </td>
            </tr>
          </TBody>
        </Table>
      )}

      {tenants && tenants.length > 0 && (
        <Table>
          <THead>
            <tr>
              <TH>{t('backoffice.clientesList.table.name')}</TH>
              <TH>{t('backoffice.clientesList.table.status')}</TH>
              <TH className="hidden sm:table-cell">{t('backoffice.clientesList.table.contact')}</TH>
              <TH className="hidden md:table-cell">{t('backoffice.clientesList.table.created')}</TH>
            </tr>
          </THead>
          <TBody>
            {tenants.map((tenant) => (
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
                <TD className="hidden md:table-cell text-brand-400">
                  {new Date(tenant.created_at).toLocaleDateString(language === 'en' ? 'en-US' : 'es-CO')}
                </TD>
              </TRow>
            ))}
          </TBody>
        </Table>
      )}

      <TenantDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} onSaved={reload} />
    </div>
  )
}
