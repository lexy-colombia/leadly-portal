import { useEffect, useRef, useState } from 'react'
import { useLanguage } from '../../../contexts/LanguageContext'
import { formatDate, formatTime } from '../../../lib/dates'
import { formatClientPhoneDisplay } from '../../../lib/phone'
import { listPosPoints } from '../../../lib/api/posPoints'
import { closeCart, createOrderFromCart, deleteCart, getCart, listOpenCarts, saveCartDraft, subscribeToOpenCarts, type OpenCartSummary } from '../../../lib/api/carts'
import { previewOrderTotals, type OrderTotalsBreakdown } from '../../../lib/api/orders'
import { getClient } from '../../../lib/api/clients'
import { getStoreCreditBalance } from '../../../lib/api/returns'
import { PaymentDrawer } from '../orders/PaymentDrawer'
import { usePosReceiptPrinter } from '../../../lib/usePosReceiptPrinter'
import { getWalkInClient } from '../../../lib/api/pos'
import type { PosPoint } from '../../../types/domain'
import { PosTabAccount } from './PosTabAccount'
import { Button } from '@/components/ui/button'
import { PageSpinner } from '@/components/atoms'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ConfirmDialog } from '@/components/organisms'
import { BanknoteIcon } from 'lucide-react'
import { OrderPaymentMethodCell, StatusDotLine } from '../orders/OrderTableCells'
import { CheckIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'

/** Una cuenta ya cobrada es la que no tiene nada pendiente por cobrar y sí
 * tiene al menos un cobro hecho -- cobrar no la cierra, así que sigue
 * abierta hasta que el cajero la cierre. */
function charged(account: OpenCartSummary): boolean {
  return account.item_count === 0 && account.charge_count > 0
}

function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Landing de "cuentas abiertas". Dos formas según cómo trabaje el tenant
 * (pedido explícito del usuario): con puntos de venta configurados
 * (Configuración > Puntos de venta) es una grilla de tarjetas, porque cada
 * tarjeta ES una mesa/caja física y lo que importa es verlas todas de un
 * vistazo, ocupadas y libres; sin puntos no hay nada físico que dibujar, así
 * que las cuentas van en una tabla como el resto de listados de la app.
 * Cada cuenta es un carrito abierto (carts, origin='pos') -- todavía no
 * existe ningún sales_orders para ninguna de ellas hasta que se cobra. */
export function PosOpenTabs({ tenantId }: { tenantId: string }) {
  const { t, language } = useLanguage()
  const [points, setPoints] = useState<PosPoint[] | null>(null)
  const [accounts, setAccounts] = useState<OpenCartSummary[] | null>(null)
  const [selectedCartId, setSelectedCartId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Cancelar una cuenta desde el listado -- misma acción destructiva que
  // dentro de la cuenta (deleteCart), con la misma confirmación. Solo se
  // ofrece mientras no haya cobrado nada (ver charge_count).
  const [confirmCancel, setConfirmCancel] = useState<OpenCartSummary | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [confirmClose, setConfirmClose] = useState<OpenCartSummary | null>(null)
  const [closing, setClosing] = useState(false)
  // Cobrar sin entrar a la cuenta: se arma con lo que ya existe -- el
  // desglose lo resuelve el servidor (previewOrderTotals) y el cobro real lo
  // hace el mismo PaymentDrawer de siempre, que crea y confirma el pedido
  // recién al registrar el pago (ver createOrder en ese componente). Acá no
  // se escribe nada al abrirlo.
  const [charge, setCharge] = useState<{
    cartId: string
    posPointName: string | null
    totals: OrderTotalsBreakdown
    creditEnabled: boolean
    storeCreditBalance: number
  } | null>(null)
  const [preparingCharge, setPreparingCharge] = useState<string | null>(null)
  const receiptPrinter = usePosReceiptPrinter(tenantId)

  function reload() {
    listOpenCarts(tenantId, 'pos')
      .then(setAccounts)
      .catch(() => setAccounts([]))
  }

  useEffect(() => {
    listPosPoints(tenantId, { activeOnly: true })
      .then(setPoints)
      .catch(() => setPoints([]))
    reload()
    const unsubscribe = subscribeToOpenCarts(tenantId, reload)
    return unsubscribe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId])

  async function handleCancel() {
    if (!confirmCancel) return
    setCancelling(true)
    try {
      await deleteCart(confirmCancel.id)
      setConfirmCancel(null)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.tabs.errors.cancel'))
    } finally {
      setCancelling(false)
    }
  }

  /** PaymentDrawer llama onSaved() y acto seguido onClose() al guardar --
   * ambos apuntan acá, así que la guarda evita recargar dos veces. */
  const chargeDoneRef = useRef(false)
  function finishCharge() {
    if (chargeDoneRef.current) return
    chargeDoneRef.current = true
    setCharge(null)
    reload()
  }

  async function handleClose() {
    if (!confirmClose) return
    setClosing(true)
    try {
      await closeCart(confirmClose.id)
      setConfirmClose(null)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.tabs.errors.close'))
    } finally {
      setClosing(false)
    }
  }

  /** Prepara el cobro de una cuenta desde el listado: relee sus ítems del
   * servidor (la lista solo trae el resumen), pide el desglose real y
   * resuelve crédito/saldo a favor del cliente para saber qué métodos de
   * pago ofrecer -- exactamente los mismos datos que usa la pantalla de la
   * cuenta, sin duplicar el flujo de cobro: lo ejecuta el PaymentDrawer. */
  async function handleChargeFromList(account: OpenCartSummary) {
    setPreparingCharge(account.id)
    setError(null)
    try {
      const cart = await getCart(account.id)
      if (!cart) throw new Error(t('pos.tabs.errors.charge'))
      const totals = await previewOrderTotals(
        cart.items.map((i) => ({
          product_id: i.product_id,
          variant_id: i.variant_id,
          warehouse_id: i.warehouse_id,
          product_name: i.product_name,
          sku: i.sku,
          quantity: i.quantity,
          unit_price: i.unit_price,
          discount_amount: i.discount_amount,
        })),
      )
      const client = cart.contact_id ? await getClient(cart.contact_id) : null
      // Mismos dos datos que mira la pantalla de la cuenta para decidir qué
      // métodos de pago ofrecer: si el cliente tiene crédito habilitado y si
      // tiene saldo a favor.
      const storeCreditBalance = client ? await getStoreCreditBalance(client.id).catch(() => 0) : 0
      chargeDoneRef.current = false
      const posPointName = account.pos_point_id ? (points?.find((p) => p.id === account.pos_point_id)?.name ?? null) : null
      setCharge({ cartId: account.id, posPointName, totals, creditEnabled: client?.credit_enabled ?? false, storeCreditBalance })
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.tabs.errors.charge'))
    } finally {
      setPreparingCharge(null)
    }
  }

  async function handleCreate(posPointId: string | null) {
    setCreating(true)
    setError(null)
    try {
      const walkIn = await getWalkInClient(tenantId)
      if (!walkIn) throw new Error(t('pos.tabs.errors.noWalkIn'))
      const cart = await saveCartDraft({ contact_id: walkIn.id, origin: 'pos', pos_point_id: posPointId, items: [] })
      setSelectedCartId(cart.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('pos.tabs.errors.create'))
    } finally {
      setCreating(false)
    }
  }

  if (selectedCartId) {
    return (
      <PosTabAccount
        tenantId={tenantId}
        cartId={selectedCartId}
        points={points ?? []}
        onBack={() => {
          setSelectedCartId(null)
          reload()
        }}
        onClosed={() => {
          setSelectedCartId(null)
          reload()
        }}
      />
    )
  }

  if (points === null || accounts === null) return <PageSpinner />

  const accountsByPoint = new Map(accounts.filter((a) => a.pos_point_id).map((a) => [a.pos_point_id as string, a]))
  const unassignedAccounts = accounts.filter((a) => !a.pos_point_id)

  return (
    <div className="space-y-4">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {points.length > 0 && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-brand-800">{t('pos.tabs.pointsTitle')}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {points.map((point) => {
              const account = accountsByPoint.get(point.id)
              if (account) {
                return (
                  <button
                    key={point.id}
                    type="button"
                    onClick={() => setSelectedCartId(account.id)}
                    className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-left transition-colors hover:bg-amber-100"
                  >
                    <p className="truncate text-sm font-semibold text-brand-800">{point.name}</p>
                    <p className="truncate text-xs text-brand-500">{account.label || account.contact_name}</p>
                    <p className="mt-1 text-sm font-bold text-brand-800">{formatCurrency(account.total)}</p>
                    {/* Una cuenta abierta sin ítems es una mesa que ya se
                        cobró y todavía no se cerró (cobrar no cierra la
                        cuenta) -- se marca para no confundirla con una
                        recién abierta. */}
                    <p className="text-[11px] text-brand-400">
                      {account.item_count === 0 ? t('pos.tabs.alreadyCharged') : t('pos.tabs.itemCount', { count: account.item_count })}
                    </p>
                  </button>
                )
              }
              return (
                <button
                  key={point.id}
                  type="button"
                  disabled={creating}
                  onClick={() => handleCreate(point.id)}
                  className="flex flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-brand-200 p-3 text-center text-brand-400 transition-colors hover:border-accent-400 hover:text-accent-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <span className="text-sm font-medium">{point.name}</span>
                  <PlusIcon width={16} height={16} />
                </button>
              )
            })}
          </div>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center justify-between">
          {/* Con puntos configurados, esta segunda sección son las cuentas
              que no están sentadas en ninguno; sin puntos, es la lista
              entera y no hace falta llamarla "Sin punto". */}
          <h2 className="text-sm font-semibold text-brand-800">{points.length > 0 ? t('pos.tabs.unassignedTitle') : t('pos.tabs.openTitle')}</h2>
          <Button type="button" size="sm" disabled={creating} onClick={() => handleCreate(null)}>
            <PlusIcon width={13} height={13} /> {t('pos.tabs.newAccount')}
          </Button>
        </div>
        {unassignedAccounts.length === 0 ? (
          <p className="rounded-xl border border-dashed border-brand-200 py-8 text-center text-sm text-brand-400">{t('pos.tabs.empty')}</p>
        ) : points.length === 0 ? (
          /* Misma tabla que Ventas (Orders.tsx) -- mismas celdas, mismo
             orden de columnas -- menos las dos de envío (dirección y estado
             de entrega), que no aplican a una cuenta de mostrador. Pedido
             explícito del usuario. */
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('orders.table.contact')}</TableHead>
                  <TableHead>{t('pos.tabs.table.status')}</TableHead>
                  <TableHead>{t('pos.tabs.table.account')}</TableHead>
                  <TableHead>{t('orders.table.paymentMethods')}</TableHead>
                  <TableHead>{t('orders.table.total')}</TableHead>
                  <TableHead>{t('orders.table.date')}</TableHead>
                  <TableHead className="text-right">{t('orders.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unassignedAccounts.map((account) => (
                  <TableRow key={account.id} onClick={() => setSelectedCartId(account.id)} className="cursor-pointer">
                    <TableCell className="text-xs text-brand-700">
                      <p className="font-medium text-brand-800">{account.contact_name}</p>
                      {account.contact_phone && (
                        <p className="text-[11px] font-normal text-brand-400">{formatClientPhoneDisplay(account.contact_phone_prefix, account.contact_phone)}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      {/* Una cuenta abierta sin productos ya se cobró y no se
                          cerró -- cobrar no cierra la mesa. */}
                      <StatusDotLine
                        label={t('pos.tabs.table.stateLabel')}
                        dotClass={charged(account) ? 'bg-emerald-500' : 'bg-amber-500'}
                        value={charged(account) ? t('pos.tabs.alreadyCharged') : t('pos.tabs.table.open')}
                      />
                    </TableCell>
                    <TableCell className="text-xs font-medium text-brand-800">{account.label || '—'}</TableCell>
                    <TableCell>
                      <OrderPaymentMethodCell methods={account.payment_methods} />
                    </TableCell>
                    <TableCell className="text-xs text-brand-700">
                      <p>{formatCurrency(account.total)}</p>
                      {account.item_count > 0 && (
                        <p className="text-[11px] text-brand-400">
                          {t(account.item_count === 1 ? 'orders.table.itemsCount.singular' : 'orders.table.itemsCount.plural', { count: account.item_count })}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-brand-500">
                      <p>{formatDate(account.created_at)}</p>
                      <p className="text-[11px] text-brand-400">{formatTime(account.created_at, language)}</p>
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {/* Dos acciones directas, con ícono, en vez de un menú
                          de tres puntos (pedido explícito del usuario): la
                          principal cambia según el estado de la cuenta
                          -- billete = cobrar lo que tiene pendiente, check =
                          cerrarla cuando ya no queda nada por cobrar -- y la
                          segunda la descarta. Abrir la cuenta no necesita
                          botón: la fila entera ya es clickeable. */}
                      <div className="flex items-center justify-end gap-1">
                        {account.item_count > 0 ? (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            disabled={preparingCharge === account.id}
                            onClick={() => handleChargeFromList(account)}
                            aria-label={t('pos.tabs.charge')}
                            title={t('pos.tabs.charge')}
                            className="text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700"
                          >
                            <BanknoteIcon className="size-4" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={() => setConfirmClose(account)}
                            aria-label={t('pos.tabs.closeAccount')}
                            title={t('pos.tabs.closeAccount')}
                            className="text-accent-600 hover:bg-accent-50 hover:text-accent-700"
                          >
                            <CheckIcon width={16} height={16} />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          disabled={account.charge_count > 0}
                          onClick={() => setConfirmCancel(account)}
                          aria-label={t('pos.tabs.cancelAccount')}
                          title={t('pos.tabs.cancelAccount')}
                          className="text-red-600 hover:bg-red-50 hover:text-red-700"
                        >
                          <TrashIcon width={14} height={14} />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
            {unassignedAccounts.map((account) => (
              <button
                key={account.id}
                type="button"
                onClick={() => setSelectedCartId(account.id)}
                className="rounded-xl border border-brand-100 bg-white p-3 text-left transition-colors hover:border-accent-300"
              >
                <p className="truncate text-sm font-semibold text-brand-800">{account.label || account.contact_name}</p>
                <p className="mt-1 text-sm font-bold text-brand-800">{formatCurrency(account.total)}</p>
                <p className="text-[11px] text-brand-400">
                  {account.item_count === 0 ? t('pos.tabs.alreadyCharged') : t('pos.tabs.itemCount', { count: account.item_count })}
                </p>
              </button>
            ))}
          </div>
        )}
      </div>

      {charge && (
        <PaymentDrawer
          open
          onClose={finishCharge}
          tenantId={tenantId}
          order={null}
          totals={charge.totals}
          pendingAmount={charge.totals.total}
          createOrder={() => createOrderFromCart(charge.cartId, undefined, { keepCartOpen: true, confirm: true })}
          creditEnabled={charge.creditEnabled}
          storeCreditBalance={charge.storeCreditBalance}
          onSaved={(chargedOrder) => {
            if (receiptPrinter.autoPrintEnabled) receiptPrinter.print(chargedOrder.id, charge.posPointName)
            finishCharge()
          }}
        />
      )}

      {receiptPrinter.portal}
      {receiptPrinter.error && <p className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 shadow-lg">{receiptPrinter.error}</p>}

      <ConfirmDialog
        open={!!confirmClose}
        onClose={() => {
          if (closing) return
          setConfirmClose(null)
        }}
        onConfirm={handleClose}
        title={t('pos.tabs.closeConfirm.title')}
        description={t('pos.tabs.closeConfirm.description')}
        loading={closing}
      />

      <ConfirmDialog
        open={!!confirmCancel}
        onClose={() => {
          if (cancelling) return
          setConfirmCancel(null)
        }}
        onConfirm={handleCancel}
        title={t('pos.tabs.cancelConfirm.title')}
        description={t('pos.tabs.cancelConfirm.description')}
        loading={cancelling}
      />
    </div>
  )
}
