import { useEffect, useMemo, useState } from 'react'
import { createDispatch, getDispatchForOrder, listDispatchHistory, updateDispatch } from '../../../lib/api/dispatches'
import { listDispatchStatuses } from '../../../lib/api/dispatchStatuses'
import { listWarehouses } from '../../../lib/api/warehouses'
import { CARRIERS, resolveTrackingUrl } from '../../../lib/carriers'
import type { Dispatch, DispatchCarrierType, DispatchStatus, DispatchStatusHistoryEntry, SalesOrder, Warehouse } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { formatDateTime } from '../../../lib/dates'
import { FieldError, PageSpinner } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

/** "Ver detalle" next to Estado de envío -- timeline + carrier/tracking
 * info for this order's dispatch. No dispatch yet -> a creation form
 * instead. One dispatch per order (see migration, no partial shipments
 * in this round). */
export function DispatchDrawer({
  open,
  onClose,
  tenantId,
  order,
  onOrderChanged,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  order: SalesOrder
  /** A dispatch status change can sync sales_orders.delivery_status server-side
   * (see apply_dispatch_stock_and_delivery_effect) -- OrderDetail.tsx's own
   * `order` state doesn't know that happened until it re-fetches. */
  onOrderChanged: () => void
}) {
  const { t } = useLanguage()
  const [statuses, setStatuses] = useState<DispatchStatus[] | null>(null)
  const [warehouses, setWarehouses] = useState<Warehouse[] | null>(null)
  const [dispatch, setDispatch] = useState<Dispatch | null | undefined>(undefined)
  const [history, setHistory] = useState<DispatchStatusHistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setDispatch(undefined)
    setHistory(null)
    Promise.all([listDispatchStatuses(tenantId), listWarehouses(tenantId), getDispatchForOrder(order.id)])
      .then(([s, w, d]) => {
        setStatuses(s)
        setWarehouses(w)
        setDispatch(d)
      })
      .catch((err) => setError(err instanceof Error ? err.message : t('dispatches.drawer.errors.load')))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantId, order.id])

  function reloadHistory(dispatchId: string) {
    listDispatchHistory(dispatchId).then(setHistory).catch(() => setHistory([]))
  }

  useEffect(() => {
    if (dispatch) reloadHistory(dispatch.id)
  }, [dispatch?.id])

  const statusById = useMemo(() => new Map((statuses ?? []).map((s) => [s.id, s])), [statuses])

  return (
    <Drawer open={open} onClose={onClose} title={t('dispatches.drawer.title')} description={t('dispatches.drawer.description')}>
      <div className="space-y-5">
        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {(dispatch === undefined || !statuses || !warehouses) && !error && <PageSpinner />}

        {dispatch === null && statuses && warehouses && (
          <DispatchCreateForm
            tenantId={tenantId}
            order={order}
            statuses={statuses}
            warehouses={warehouses}
            onCreated={(d) => {
              setDispatch(d)
              onOrderChanged()
            }}
          />
        )}

        {dispatch && statuses && warehouses && (
          <DispatchDetail
            dispatch={dispatch}
            statuses={statuses}
            warehouses={warehouses}
            history={history}
            statusById={statusById}
            onChanged={(d) => {
              setDispatch(d)
              reloadHistory(d.id)
              onOrderChanged()
            }}
          />
        )}
      </div>
    </Drawer>
  )
}

function DispatchCreateForm({
  tenantId,
  order,
  statuses,
  warehouses,
  onCreated,
}: {
  tenantId: string
  order: SalesOrder
  statuses: DispatchStatus[]
  warehouses: Warehouse[]
  onCreated: (d: Dispatch) => void
}) {
  const { t } = useLanguage()
  const defaultWarehouse = warehouses.find((w) => w.is_default) ?? warehouses[0]
  const [warehouseId, setWarehouseId] = useState(defaultWarehouse?.id ?? '')
  const [carrierType, setCarrierType] = useState<DispatchCarrierType>('propio')
  const [carrierKey, setCarrierKey] = useState(CARRIERS[0].key)
  const [carrierName, setCarrierName] = useState('')
  const [trackingNumber, setTrackingNumber] = useState('')
  const [trackingUrl, setTrackingUrl] = useState('')
  const [notes, setNotes] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const warehouseError = touched && !warehouseId ? t('dispatches.drawer.errors.warehouseRequired') : undefined
  const trackingError = touched && carrierType === 'tercero' && !trackingNumber.trim() ? t('dispatches.drawer.errors.trackingNumberRequired') : undefined

  async function handleSubmit() {
    setTouched(true)
    setFormError(null)
    if (!warehouseId || (carrierType === 'tercero' && !trackingNumber.trim())) return

    setSubmitting(true)
    try {
      const firstStatus = statuses[0]
      const resolvedUrl = carrierType === 'tercero' ? resolveTrackingUrl(carrierKey, trackingNumber.trim() || null, trackingUrl.trim() || null) : null
      const dispatch = await createDispatch({
        tenant_id: tenantId,
        sales_order_id: order.id,
        status_id: firstStatus.id,
        warehouse_id: warehouseId,
        carrier_type: carrierType,
        carrier_key: carrierType === 'tercero' ? carrierKey : null,
        carrier_name: carrierType === 'tercero' && carrierKey === 'otro' ? carrierName.trim() || null : null,
        tracking_number: carrierType === 'tercero' ? trackingNumber.trim() || null : null,
        tracking_url: resolvedUrl,
        notes: notes.trim() || null,
      })
      onCreated(dispatch)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('dispatches.drawer.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-brand-500">{t('dispatches.drawer.noDispatch.title')}</p>

      <div>
        <Label htmlFor="dispatch-warehouse">{t('dispatches.drawer.fields.warehouse')}</Label>
        <Select value={warehouseId} onValueChange={setWarehouseId}>
          <SelectTrigger id="dispatch-warehouse" className={`mt-1 w-full ${FIELD_CLASS}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {warehouses.map((w) => (
              <SelectItem key={w.id} value={w.id} className="text-xs">
                {w.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FieldError message={warehouseError} />
      </div>

      <div>
        <Label htmlFor="dispatch-carrier-type">{t('dispatches.drawer.fields.carrierType')}</Label>
        <Select value={carrierType} onValueChange={(v) => setCarrierType(v as DispatchCarrierType)}>
          <SelectTrigger id="dispatch-carrier-type" className={`mt-1 w-full ${FIELD_CLASS}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="propio" className="text-xs">
              {t('dispatches.drawer.fields.carrierType.propio')}
            </SelectItem>
            <SelectItem value="tercero" className="text-xs">
              {t('dispatches.drawer.fields.carrierType.tercero')}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {carrierType === 'tercero' && (
        <>
          <div>
            <Label htmlFor="dispatch-carrier">{t('dispatches.drawer.fields.carrier')}</Label>
            <Select value={carrierKey} onValueChange={setCarrierKey}>
              <SelectTrigger id="dispatch-carrier" className={`mt-1 w-full ${FIELD_CLASS}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CARRIERS.map((c) => (
                  <SelectItem key={c.key} value={c.key} className="text-xs">
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {carrierKey === 'otro' && (
            <div>
              <Label htmlFor="dispatch-carrier-name">{t('dispatches.drawer.fields.carrierName')}</Label>
              <Input id="dispatch-carrier-name" value={carrierName} onChange={(e) => setCarrierName(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            </div>
          )}

          <div>
            <Label htmlFor="dispatch-tracking-number">{t('dispatches.drawer.fields.trackingNumber')}</Label>
            <Input id="dispatch-tracking-number" value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
            <FieldError message={trackingError} />
          </div>

          {carrierKey === 'otro' && (
            <div>
              <Label htmlFor="dispatch-tracking-url">{t('dispatches.drawer.fields.trackingUrl')}</Label>
              <Input id="dispatch-tracking-url" value={trackingUrl} onChange={(e) => setTrackingUrl(e.target.value)} placeholder="https://" className={`mt-1 ${FIELD_CLASS}`} />
              <p className="mt-1 text-[11px] text-brand-400">{t('dispatches.drawer.fields.trackingUrlHint')}</p>
            </div>
          )}
        </>
      )}

      <div>
        <Label htmlFor="dispatch-notes">{t('dispatches.drawer.fields.notes')}</Label>
        <Textarea id="dispatch-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} className="mt-1 !rounded-lg !text-xs" />
      </div>

      {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

      <div className="border-t border-brand-100 pt-4">
        <Button type="button" onClick={handleSubmit} disabled={submitting}>
          {submitting ? t('dispatches.drawer.actions.creating') : t('dispatches.drawer.actions.create')}
        </Button>
      </div>
    </div>
  )
}

function DispatchDetail({
  dispatch,
  statuses,
  warehouses,
  history,
  statusById,
  onChanged,
}: {
  dispatch: Dispatch
  statuses: DispatchStatus[]
  warehouses: Warehouse[]
  history: DispatchStatusHistoryEntry[] | null
  statusById: Map<string, DispatchStatus>
  onChanged: (d: Dispatch) => void
}) {
  const { t, language } = useLanguage()
  const [changingStatus, setChangingStatus] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const warehouse = warehouses.find((w) => w.id === dispatch.warehouse_id)
  const carrier = CARRIERS.find((c) => c.key === dispatch.carrier_key)
  const trackingUrl = resolveTrackingUrl(dispatch.carrier_key, dispatch.tracking_number, dispatch.tracking_url)

  async function handleStatusChange(statusId: string) {
    if (statusId === dispatch.status_id) return
    setChangingStatus(true)
    setError(null)
    try {
      const updated = await updateDispatch(dispatch.id, { status_id: statusId })
      onChanged(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dispatches.drawer.errors.save'))
    } finally {
      setChangingStatus(false)
    }
  }

  return (
    <div className="space-y-5">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div>
        <Label htmlFor="dispatch-status">{t('dispatches.drawer.fields.status')}</Label>
        <Select value={dispatch.status_id} onValueChange={handleStatusChange} disabled={changingStatus}>
          <SelectTrigger id="dispatch-status" className={`mt-1 w-full ${FIELD_CLASS}`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {statuses.map((s) => (
              <SelectItem key={s.id} value={s.id} className="text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: s.color }} />
                  {s.name}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-brand-100 p-3 text-xs">
        <div>
          <dt className="text-brand-400">{t('dispatches.drawer.fields.warehouse')}</dt>
          <dd className="font-medium text-brand-800">{warehouse?.name ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-brand-400">{t('dispatches.drawer.fields.carrierType')}</dt>
          <dd className="font-medium text-brand-800">{t(dispatch.carrier_type === 'propio' ? 'dispatches.drawer.fields.carrierType.propio' : 'dispatches.drawer.fields.carrierType.tercero')}</dd>
        </div>
        {dispatch.carrier_type === 'tercero' && (
          <>
            <div>
              <dt className="text-brand-400">{t('dispatches.drawer.fields.carrier')}</dt>
              <dd className="font-medium text-brand-800">{carrier?.key === 'otro' ? dispatch.carrier_name || carrier.name : carrier?.name ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-brand-400">{t('dispatches.drawer.fields.trackingNumber')}</dt>
              <dd className="font-medium text-brand-800">{dispatch.tracking_number ?? '—'}</dd>
            </div>
          </>
        )}
      </dl>

      {trackingUrl && (
        <a href={trackingUrl} target="_blank" rel="noreferrer">
          <Button type="button" variant="secondary" size="sm" className="w-full">
            {t('dispatches.drawer.actions.viewTracking')}
          </Button>
        </a>
      )}

      <div className="border-t border-brand-100 pt-4">
        <p className="mb-3 text-sm font-semibold text-brand-800">{t('dispatches.drawer.timeline.title')}</p>
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
    </div>
  )
}
