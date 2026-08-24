import { useEffect, useMemo, useState } from 'react'
import { getReturn, listReturnHistory, listReturnItems, setReturnItemCondition, updateReturn, type ReturnItemWithOrderItem, type ReturnWithOrder } from '../../../lib/api/returns'
import { listReturnStatuses } from '../../../lib/api/returnStatuses'
import { listReturnResolutionTypes } from '../../../lib/api/returnResolutionTypes'
import { RETURN_REASON_LABEL_KEY } from '../../../lib/returnReasons'
import type { ReturnItemCondition, ReturnResolutionType, ReturnStatus, ReturnStatusHistoryEntry } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { formatDateTime } from '../../../lib/dates'
import { PageSpinner } from '@/components/atoms'
import { CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

const CONDITION_KEYS: ReturnItemCondition[] = ['pendiente', 'bueno', 'danado']
const CONDITION_LABEL_KEY: Record<ReturnItemCondition, TranslationKey> = {
  pendiente: 'returns.detail.condition.pendiente',
  bueno: 'returns.detail.condition.bueno',
  danado: 'returns.detail.condition.danado',
}

/** Ver/gestionar un ticket ya creado: cambiar estado, inspeccionar cada
 * ítem (condición dispara el efecto de inventario del lado del servidor,
 * ver apply_return_item_stock_effect), elegir cómo se resuelve, y el
 * timeline. Ningún campo tiene un botón "Guardar" -- autosave por campo,
 * mismo criterio que PipelineSettingsDrawer/DispatchStatusesSection. */
export function ReturnDetailDrawer({ open, onClose, returnId, tenantId }: { open: boolean; onClose: () => void; returnId: string; tenantId: string }) {
  const { t, language } = useLanguage()
  const [ret, setRet] = useState<ReturnWithOrder | null | undefined>(undefined)
  const [items, setItems] = useState<ReturnItemWithOrderItem[] | null>(null)
  const [history, setHistory] = useState<ReturnStatusHistoryEntry[] | null>(null)
  const [statuses, setStatuses] = useState<ReturnStatus[]>([])
  const [resolutionTypes, setResolutionTypes] = useState<ReturnResolutionType[]>([])
  const [error, setError] = useState<string | null>(null)
  const [amountDraft, setAmountDraft] = useState('')

  function reload() {
    getReturn(returnId).then(setRet).catch(() => setRet(null))
    listReturnItems(returnId).then(setItems).catch(() => setItems([]))
    listReturnHistory(returnId).then(setHistory).catch(() => setHistory([]))
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    setRet(undefined)
    setItems(null)
    setHistory(null)
    reload()
    listReturnStatuses(tenantId).then(setStatuses).catch(() => setStatuses([]))
    listReturnResolutionTypes(tenantId).then(setResolutionTypes).catch(() => setResolutionTypes([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, returnId, tenantId])

  useEffect(() => {
    setAmountDraft(ret?.resolution_amount != null ? String(ret.resolution_amount) : '')
  }, [ret?.resolution_amount])

  const statusById = useMemo(() => new Map(statuses.map((s) => [s.id, s])), [statuses])
  const activeResolutionTypes = useMemo(() => resolutionTypes.filter((r) => r.is_active || r.id === ret?.resolution_type_id), [resolutionTypes, ret?.resolution_type_id])
  const selectedResolutionType = resolutionTypes.find((r) => r.id === ret?.resolution_type_id)

  async function handleStatusChange(statusId: string) {
    if (!ret) return
    try {
      await updateReturn(ret.id, { status_id: statusId })
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('returns.detail.errors.save'))
    }
  }

  async function handleResolutionTypeChange(resolutionTypeId: string) {
    if (!ret) return
    try {
      await updateReturn(ret.id, { resolution_type_id: resolutionTypeId || null })
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('returns.detail.errors.save'))
    }
  }

  async function handleAmountBlur() {
    if (!ret) return
    const value = amountDraft.trim() === '' ? null : Number(amountDraft)
    if (value === ret.resolution_amount) return
    try {
      await updateReturn(ret.id, { resolution_amount: value })
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('returns.detail.errors.save'))
    }
  }

  async function handleConditionChange(itemId: string, condition: ReturnItemCondition) {
    try {
      await setReturnItemCondition(itemId, condition)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('returns.detail.errors.save'))
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('returns.detail.title')} description={ret?.sales_order ? t('returns.detail.order', { number: ret.sales_order.number }) : undefined}>
      <div className="space-y-5">
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {ret === undefined && <PageSpinner />}
        {ret === null && <p className="text-sm text-brand-500">{t('returns.detail.errors.load')}</p>}

        {ret && (
          <>
            <div>
              <Label>{t('returns.detail.fields.status')}</Label>
              <Select value={ret.status_id} onValueChange={handleStatusChange}>
                <SelectTrigger className="mt-1 w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {statuses.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      <span className="flex items-center gap-1.5">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                        {s.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>{t('returns.detail.fields.reason')}</Label>
              <p className="mt-1 text-sm text-brand-700">{t(RETURN_REASON_LABEL_KEY[ret.reason])}</p>
            </div>

            <div className="border-t border-brand-100 pt-4">
              <p className="mb-2 text-sm font-semibold text-brand-800">{t('returns.detail.items.title')}</p>
              {!items && <PageSpinner />}
              {items && (
                <div className="space-y-2">
                  {items.map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-2 rounded-lg border border-brand-100 p-2">
                      <span className="min-w-0 flex-1 truncate text-xs text-brand-700">
                        {item.sales_order_item?.product_name ?? '—'} · {item.quantity}
                      </span>
                      <Select value={item.condition} onValueChange={(v) => handleConditionChange(item.id, v as ReturnItemCondition)}>
                        <SelectTrigger className="!h-7 w-auto !rounded-lg !text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONDITION_KEYS.map((c) => (
                            <SelectItem key={c} value={c} className="text-xs">
                              {t(CONDITION_LABEL_KEY[c])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="border-t border-brand-100 pt-4">
              <div>
                <Label>{t('returns.detail.fields.resolutionType')}</Label>
                <Select value={ret.resolution_type_id ?? ''} onValueChange={handleResolutionTypeChange}>
                  <SelectTrigger className="mt-1 w-full">
                    <SelectValue placeholder={t('returns.detail.fields.resolutionTypeNone')} />
                  </SelectTrigger>
                  <SelectContent>
                    {activeResolutionTypes.map((r) => (
                      <SelectItem key={r.id} value={r.id}>
                        {r.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {selectedResolutionType && selectedResolutionType.effect !== 'ninguno' && (
                <div className="mt-3">
                  <Label htmlFor="return-amount">{t('returns.detail.fields.resolutionAmount')}</Label>
                  <CurrencyInput id="return-amount" value={amountDraft} onChange={(e) => setAmountDraft(e.target.value)} onBlur={handleAmountBlur} className="mt-1" />
                </div>
              )}

              {ret.credit_granted && ret.resolution_amount != null && (
                <p className="mt-2 rounded-lg bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-700">
                  {t('returns.detail.storeCreditGranted', { amount: formatCurrency(ret.resolution_amount) })}
                </p>
              )}
            </div>

            {ret.notes && (
              <div className="border-t border-brand-100 pt-4">
                <Label>{t('returns.detail.fields.notes')}</Label>
                <Textarea value={ret.notes} readOnly rows={2} className="mt-1 resize-none bg-brand-50/40" />
              </div>
            )}

            <div className="border-t border-brand-100 pt-4">
              <p className="mb-3 text-sm font-semibold text-brand-800">{t('returns.detail.timeline.title')}</p>
              {!history && <PageSpinner />}
              {history && (
                <ol className="space-y-3">
                  {history.map((entry, index) => {
                    const status = statusById.get(entry.to_status_id)
                    return (
                      <li key={entry.id} className="flex gap-3">
                        <div className="flex flex-col items-center">
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: status?.color ?? '#94A3B8' }} />
                          {index < history.length - 1 && <span className="mt-0.5 w-px flex-1 bg-brand-100" />}
                        </div>
                        <div className="pb-3">
                          <p className="text-sm font-medium text-brand-800">{status?.name ?? '—'}</p>
                          <p className="text-xs text-brand-400">{formatDateTime(entry.created_at, language)}</p>
                        </div>
                      </li>
                    )
                  })}
                </ol>
              )}
            </div>
          </>
        )}
      </div>
    </Drawer>
  )
}
