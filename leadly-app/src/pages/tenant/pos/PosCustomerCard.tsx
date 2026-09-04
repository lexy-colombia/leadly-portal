import { useEffect, useState } from 'react'
import { searchPosClients } from '../../../lib/api/pos'
import { formatClientPhoneDisplay } from '../../../lib/phone'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { Client } from '../../../types/domain'
import { Input } from '@/components/ui/input'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Tarjeta de cliente del POS -- extraída de la venta rápida original
 * para compartirla con las cuentas abiertas (PosTabAccount.tsx), mismo
 * comportamiento en los dos lugares: Consumidor Final por default,
 * buscar/cambiar, y (si es un cliente real) documento/teléfono/correo +
 * saldo de crédito/a favor -- el cajero necesita verlo para decidir el
 * método de pago. `creditBalance`/`storeCreditBalance` se calculan en el
 * padre (alimentan también el filtro del selector de método de pago), no
 * acá -- solo se muestran. */
export function PosCustomerCard({
  tenantId,
  walkInName,
  customer,
  onSelect,
  creditBalance,
  storeCreditBalance,
}: {
  tenantId: string
  walkInName?: string
  customer: Client | null
  onSelect: (client: Client | null) => void
  creditBalance: number
  storeCreditBalance: number
}) {
  const { t } = useLanguage()
  const [changing, setChanging] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Client[]>([])
  const [searching, setSearching] = useState(false)

  useEffect(() => {
    if (!tenantId || query.trim().length < 2) {
      setResults([])
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      searchPosClients(tenantId, query)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false))
    }, 250)
    return () => clearTimeout(timer)
  }, [tenantId, query])

  return (
    <div className="rounded-2xl border border-brand-100 bg-white p-3.5">
      <h2 className="mb-2 text-sm font-semibold text-brand-800">{t('pos.customer.label')}</h2>
      {!changing ? (
        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-sm text-brand-700">{customer?.full_name ?? walkInName ?? t('pos.customer.walkIn')}</p>
            <button type="button" onClick={() => setChanging(true)} className="shrink-0 text-xs font-medium text-accent-600 hover:underline">
              {t('pos.customer.change')}
            </button>
          </div>
          {customer && (
            <div className="mt-1.5 space-y-0.5 text-xs text-brand-400">
              {(customer.document_type || customer.document_number) && <p className="truncate">{[customer.document_type, customer.document_number].filter(Boolean).join(' ')}</p>}
              <p className="truncate">{formatClientPhoneDisplay(customer.phone_prefix, customer.phone)}</p>
              {customer.email && <p className="truncate">{customer.email}</p>}
              {customer.credit_enabled && (
                <p className="flex items-center justify-between gap-2 pt-0.5">
                  <span>{t('credit.table.balance')}</span>
                  <span className="font-medium text-brand-600">{formatCurrency(creditBalance)}</span>
                </p>
              )}
              {storeCreditBalance > 0 && (
                <p className="flex items-center justify-between gap-2">
                  <span>{t('orders.paymentMethod.storeCredit')}</span>
                  <span className="font-medium text-emerald-600">{formatCurrency(storeCreditBalance)}</span>
                </p>
              )}
            </div>
          )}
        </div>
      ) : (
        <div>
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('pos.customer.searchPlaceholder')} autoFocus className="h-9 text-sm" />
          <div className="mt-2 max-h-48 divide-y divide-brand-100 overflow-y-auto rounded-lg border border-brand-100">
            {searching && <p className="px-3 py-2 text-xs text-brand-400">{t('pos.search.searching')}</p>}
            {!searching && query.trim().length >= 2 && results.length === 0 && <p className="px-3 py-2 text-xs text-brand-400">{t('pos.customer.noResults')}</p>}
            {!searching &&
              results.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    onSelect(c)
                    setChanging(false)
                    setQuery('')
                    setResults([])
                  }}
                  className="block w-full px-3 py-2 text-left text-sm hover:bg-accent-50"
                >
                  <span className="block truncate font-medium text-brand-800">{c.full_name}</span>
                  <span className="block truncate text-xs text-brand-400">{c.document_number ?? c.phone}</span>
                </button>
              ))}
          </div>
          <button
            type="button"
            onClick={() => {
              onSelect(null)
              setChanging(false)
              setQuery('')
            }}
            className="mt-2 text-xs font-medium text-brand-400 hover:text-brand-600"
          >
            {t('pos.customer.useWalkIn')}
          </button>
        </div>
      )}
    </div>
  )
}
