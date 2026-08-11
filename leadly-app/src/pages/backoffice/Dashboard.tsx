import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { getBackofficeDashboardStats, type BackofficeDashboardStats } from '../../lib/api/dashboard'
import { listTenants } from '../../lib/api/tenants'
import type { Tenant } from '../../types/domain'
import { Badge, Card, EmptyState, InitialsAvatar, PageSpinner } from '../../components/ui'
import { BuildingIcon, ChatBubbleIcon, PhoneIcon } from '../../components/icons'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language } from '../../i18n/translations'

function formatDate(iso: string, language: Language): string {
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })
}

function StatCard({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-500">{icon}</span>
        <div className="min-w-0">
          <p className="truncate text-xl font-bold text-brand-800">{value}</p>
          <p className="truncate text-xs text-brand-400">{label}</p>
        </div>
      </div>
    </Card>
  )
}

export function Dashboard() {
  const { t, language } = useLanguage()
  const [stats, setStats] = useState<BackofficeDashboardStats | null>(null)
  const [tenants, setTenants] = useState<Tenant[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getBackofficeDashboardStats()
      .then(setStats)
      .catch((err) => setError(err.message ?? t('backoffice.dashboard.errors.load')))
    listTenants().then(setTenants).catch(() => setTenants([]))
  }, [])

  const recentTenants = (tenants ?? []).slice(0, 5)

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard
          icon={<BuildingIcon width={18} height={18} />}
          label={t('backoffice.dashboard.activeTenants')}
          value={stats ? `${stats.activeTenants} / ${stats.totalTenants}` : '—'}
        />
        <StatCard
          icon={<PhoneIcon width={18} height={18} />}
          label={t('backoffice.dashboard.activeLines')}
          value={stats ? `${stats.activeLines} / ${stats.totalLines}` : '—'}
        />
        <StatCard
          icon={<ChatBubbleIcon width={18} height={18} />}
          label={t('backoffice.dashboard.conversationsToday')}
          value={stats ? String(stats.conversationsToday) : '—'}
        />
      </div>

      <Card>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-brand-800">{t('backoffice.dashboard.recentTenants')}</h2>
          <Link to="/backoffice/clientes" className="text-xs font-medium text-accent-600 hover:text-accent-700">
            {t('common.actions.viewAll')}
          </Link>
        </div>
        {!tenants && <PageSpinner />}
        {tenants && recentTenants.length === 0 && <EmptyState>{t('backoffice.dashboard.empty')}</EmptyState>}
        {tenants && recentTenants.length > 0 && (
          <ul className="space-y-2">
            {recentTenants.map((tenant) => (
              <li key={tenant.id}>
                <Link
                  to={`/backoffice/clientes/${tenant.id}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-brand-100 px-3.5 py-2.5 transition-colors hover:bg-brand-50"
                >
                  <span className="flex min-w-0 items-center gap-3">
                    {tenant.logo_url ? (
                      <img src={tenant.logo_url} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                    ) : (
                      <InitialsAvatar name={tenant.name} size="sm" />
                    )}
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium text-brand-800">{tenant.name}</span>
                      <span className="block truncate text-xs text-brand-400">
                        {t('backoffice.dashboard.since', { date: formatDate(tenant.created_at, language) })}
                      </span>
                    </span>
                  </span>
                  <Badge tone={tenant.status === 'active' ? 'success' : 'neutral'}>
                    {tenant.status === 'active' ? t('common.status.active') : t('common.status.inactive')}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}
