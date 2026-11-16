import { useCallback, useEffect, useState } from 'react'
import { listBillingProfilesForPicker } from '../../../lib/api/billingProfiles'
import { billingProfileMissingKeys } from '../../../lib/billingProfile'
import type { ClientBillingProfile } from '../../../types/domain'
import { usePermission } from '../../../contexts/AuthContext'
import { useLanguage } from '../../../contexts/LanguageContext'
import { PlusIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BillingProfileDrawer } from './BillingProfileDrawer'
import { BillingMissingList } from './BillingMissingList'

function profileText(p: ClientBillingProfile): string {
  return [p.label, p.legal_name, p.document_number].filter(Boolean).join(' · ')
}

/** Selector «Facturar a»: elige entre los perfiles de facturación del cliente
 * de la venta (o agrega uno). Elegir un perfil NO cambia el predeterminado del
 * cliente ni el dueño de la venta: solo decide a quién va la factura.
 *
 * `value` vacío = «el predeterminado» (el servidor lo resuelve); la lista de
 * faltantes que se muestra es informativa. Agregar/crear requiere
 * `contacts.edit_billing`. */
export function BillingProfilePicker({
  tenantId,
  clientId,
  isWalkIn = false,
  value,
  onChange,
  disabled = false,
  serverMissing,
  idPrefix = 'billing-to',
  lockedHint,
}: {
  tenantId: string
  clientId: string | null
  isWalkIn?: boolean
  value: string
  onChange: (profileId: string) => void
  disabled?: boolean
  /** Lista de faltantes que devolvió el servidor para esta venta. */
  serverMissing?: string[]
  idPrefix?: string
  /** Texto bajo el selector cuando está fijo (p. ej. el pedido ya se creó). */
  lockedHint?: string
}) {
  const { t } = useLanguage()
  const canAdd = usePermission('contacts.edit_billing')
  const [rows, setRows] = useState<ClientBillingProfile[] | null>(null)
  const [total, setTotal] = useState(0)
  const [loadError, setLoadError] = useState(false)
  const [drawerOpen, setDrawerOpen] = useState(false)

  const load = useCallback(() => {
    if (!clientId || isWalkIn) {
      setRows([])
      setTotal(0)
      return () => {}
    }
    let cancelled = false
    setRows(null)
    setLoadError(false)
    listBillingProfilesForPicker(clientId)
      .then((res) => {
        if (cancelled) return
        setRows(res.rows)
        setTotal(res.total)
      })
      .catch(() => {
        if (cancelled) return
        setRows([])
        setLoadError(true)
      })
    return () => {
      cancelled = true
    }
  }, [clientId, isWalkIn])

  useEffect(() => load(), [load])

  // Si la venta apunta a un perfil que ya no existe (eliminado), NO se muestra el
  // predeterminado como si fuera el elegido: se avisa y se pide elegir otro.
  const unavailable = !!rows && !!value && total <= rows.length && !rows.some((p) => p.id === value)
  const effective = rows && !unavailable ? (rows.find((p) => p.id === value) ?? rows.find((p) => p.is_default) ?? null) : null

  if (isWalkIn) {
    return (
      <div>
        <Label>{t('billingTo.label')}</Label>
        <p className="mt-1 text-xs text-brand-400">{t('billingTo.walkIn')}</p>
      </div>
    )
  }

  return (
    <div className="min-w-0">
      <Label htmlFor={`${idPrefix}-select`}>{t('billingTo.label')}</Label>
      {!clientId && <p className="mt-1 text-xs text-brand-400">{t('billingTo.noClient')}</p>}
      {clientId && rows === null && <p className="mt-1 text-xs text-brand-400">{t('billingTo.loading')}</p>}
      {clientId && loadError && <p className="mt-1 text-xs text-red-700">{t('billingTo.loadError')}</p>}
      {clientId && rows && !loadError && (
        <div className="mt-1 flex gap-2">
          {rows.length > 0 ? (
            <Select value={effective?.id ?? ''} onValueChange={onChange} disabled={disabled}>
              <SelectTrigger id={`${idPrefix}-select`} className="!h-7 min-w-0 flex-1 !rounded-lg !text-xs">
                <SelectValue placeholder={t('common.form.selectPlaceholder')}>{effective ? profileText(effective) : undefined}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {rows.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="text-xs">
                    {profileText(p)}
                    {p.is_default ? ` (${t('contacts.detail.addresses.default').toLowerCase()})` : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="flex-1 self-center text-xs text-brand-400">{t('billingTo.none')}</p>
          )}
          {canAdd && (
            <Button type="button" size="icon" disabled={disabled} onClick={() => setDrawerOpen(true)} aria-label={t('billingTo.addAria')} className="shrink-0">
              <PlusIcon width={14} height={14} />
            </Button>
          )}
        </div>
      )}
      {unavailable && <p className="mt-1 text-xs text-red-700">{t('billingTo.unavailable')}</p>}
      {lockedHint && <p className="mt-1 text-[11px] text-brand-400">{lockedHint}</p>}
      {rows && total > rows.length && <p className="mt-1 text-[11px] text-brand-400">{t('billingTo.moreProfiles', { count: total })}</p>}
      {clientId && rows && (
        <div className="mt-2">
          <BillingMissingList keys={effective && !serverMissing?.length ? billingProfileMissingKeys(effective) : undefined} serverMissing={serverMissing} />
        </div>
      )}
      {clientId && (
        <BillingProfileDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          tenantId={tenantId}
          clientId={clientId}
          onSaved={(saved) => {
            onChange(saved.id)
            load()
          }}
        />
      )}
    </div>
  )
}
