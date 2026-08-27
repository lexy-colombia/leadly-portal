import { useEffect, useRef, useState } from 'react'
import { Link, useOutletContext, useSearchParams } from 'react-router-dom'
import { REGEXP_ONLY_DIGITS } from 'input-otp'
import { CheckIcon, Loader2Icon, MapPinIcon, PlusIcon, TrashIcon } from 'lucide-react'
import { useLanguage } from '../../contexts/LanguageContext'
import {
  checkoutStorefrontCart,
  getStorefrontCart,
  getStorefrontOrderStatus,
  removeStorefrontCartItem,
  requestCheckoutOtp,
  selectStorefrontPaymentMethod,
  updateStorefrontCartItem,
  verifyCheckoutOtp,
  type CheckoutAddressInput,
  type CheckoutResult,
  type OrderStatusResult,
  type StorefrontCartItem,
  type StorefrontSavedAddress,
} from '../../lib/api/storefront'
import { getStorefrontCartToken, clearStorefrontCartToken } from '../../lib/storefrontCart'
import { useDebouncedQuantity } from '../../lib/useDebouncedQuantity'
import { DOCUMENT_TYPES } from '../../lib/referenceData'
import type { StorefrontOutletContext } from '../../layouts/StorefrontLayout'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { PhoneInput } from '@/components/molecules'
import { StorefrontImage } from '@/components/storefront/StorefrontImage'

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

type Step = 'cart' | 'identify' | 'otp' | 'details' | 'choose_payment' | 'success'

interface AddressDisplay {
  line1: string
  city: string | null
  state_province: string | null
}

/** Snapshot de lo que efectivamente se compró, tomado en `submitCheckout`
 * ANTES de limpiar el token del carrito -- `items`/`total` del estado
 * principal no sirven para la pantalla de éxito: en cuanto se limpia el
 * token, el efecto que sincroniza `items` con el carrito del servidor (ver
 * abajo) se dispara de nuevo con `token=null` y los vacía. */
interface OrderSummary {
  items: StorefrontCartItem[]
  total: number
  fullName: string
  phone: string
  shippingAddress: AddressDisplay
  billingAddress: AddressDisplay
  billingSameAsShipping: boolean
}

/** Carrito + checkout en 4 pasos -- ver CLAUDE.md, "Verificación de
 * identidad": sin OTP, cualquiera podría escribir el teléfono de un cliente
 * real y comprar a su nombre (grave si tiene crédito habilitado).
 *
 * Rediseño explícito del usuario (2026-08-26): antes el OTP no llevaba a
 * ningún lado -- se verificaba el teléfono y de ahí igual había que tipear
 * nombre/dirección de cero, cliente nuevo o no. Ahora "identify" solo junta
 * documento+teléfono (nunca la dirección -- eso lo autogestiona el cliente
 * en "details"), y recién DESPUÉS de confirmar el código (verify_checkout_otp)
 * se revela si ese teléfono ya es cliente y se precargan su nombre y sus
 * direcciones guardadas -- nunca antes, para no convertir esto en un oráculo
 * de "este teléfono ya es cliente" para cualquiera que solo sepa el número.
 *
 * Envío y facturación son direcciones independientes (pedido explícito del
 * usuario, "la facturación es de donde saco los datos para la factura") --
 * por default van a la misma, pero se puede facturar a una distinta,
 * guardada o nueva, igual que ya hace el portal interno del tenant en
 * OrderDetail.tsx. */
export function StorefrontCart() {
  const { slug, refreshCartCount, showError } = useOutletContext<StorefrontOutletContext>()
  const { t } = useLanguage()
  const token = getStorefrontCartToken(slug)
  const [searchParams] = useSearchParams()

  // Volviendo del checkout externo de Wompi (?payment=return en el
  // redirect_url que arma submitCheckout) -- pedido explícito del usuario:
  // "que retorne a la misma página donde se solicitó el pago pero diciendo
  // que el pago fue confirmado". Esta es una recarga completa del browser
  // (Wompi vive en otro dominio), así que no queda nada en memoria de React
  // del checkout que se hizo -- se reconstruye consultando get_order_status
  // con el mismo token que ya vivía en localStorage desde antes de irse a
  // pagar (por eso el token NO se limpia al generar el link, ver
  // submitCheckout). El webhook de Wompi puede tardar unos segundos más que
  // el propio redirect en confirmar -- reintenta unas pocas veces antes de
  // resignarse a "seguimos confirmando".
  const [paymentReturn, setPaymentReturn] = useState<OrderStatusResult | 'checking' | 'timeout' | null>(searchParams.get('payment') === 'return' ? 'checking' : null)

  useEffect(() => {
    if (paymentReturn !== 'checking' || !token) return
    let cancelled = false
    let attempts = 0
    const poll = () => {
      getStorefrontOrderStatus(token)
        .then((status) => {
          if (cancelled) return
          if (status.paid || attempts >= 4) {
            setPaymentReturn(status.paid ? status : 'timeout')
            clearStorefrontCartToken(slug)
            refreshCartCount([])
            return
          }
          attempts += 1
          setTimeout(poll, 2000)
        })
        .catch(() => {
          if (!cancelled) setPaymentReturn('timeout')
        })
    }
    poll()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentReturn, token])

  const [items, setItems] = useState<StorefrontCartItem[] | null>(null)
  const [step, setStep] = useState<Step>('cart')
  const [phone, setPhone] = useState('')
  const [documentType, setDocumentType] = useState('CC')
  const [documentNumber, setDocumentNumber] = useState('')
  const [otp, setOtp] = useState('')
  const [fullName, setFullName] = useState('')

  const [savedAddresses, setSavedAddresses] = useState<StorefrontSavedAddress[]>([])
  const [selectedShippingId, setSelectedShippingId] = useState<string | null>(null)
  const [shippingLine1, setShippingLine1] = useState('')
  const [shippingCity, setShippingCity] = useState('')
  const [shippingStateProvince, setShippingStateProvince] = useState('')

  const [billingSameAsShipping, setBillingSameAsShipping] = useState(true)
  const [selectedBillingId, setSelectedBillingId] = useState<string | null>(null)
  const [billingLine1, setBillingLine1] = useState('')
  const [billingCity, setBillingCity] = useState('')
  const [billingStateProvince, setBillingStateProvince] = useState('')

  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckoutResult | null>(null)
  const [orderSummary, setOrderSummary] = useState<OrderSummary | null>(null)

  // Espejo síncrono de `items` -- commitItemQuantity lo necesita para poder
  // mezclar sin depender de un closure viejo de `items`. Ver el comentario
  // de esa función: ajustar dos líneas distintas del carrito casi al mismo
  // tiempo disparaba 2 mutaciones en paralelo, y la respuesta que llegara
  // tarde pisaba TODO el arreglo con su propia foto parcial (a veces sin la
  // otra línea todavía).
  const itemsRef = useRef<StorefrontCartItem[]>([])

  useEffect(() => {
    if (!token) {
      itemsRef.current = []
      setItems([])
      return
    }
    getStorefrontCart(token)
      .then((res) => {
        itemsRef.current = res.items
        setItems(res.items)
      })
      .catch(() => {
        itemsRef.current = []
        setItems([])
      })
  }, [token])

  const total = (items ?? []).reduce((sum, item) => sum + item.subtotal, 0)

  // Único punto de guardado real para la cantidad de un ítem -- lo llama
  // CartLineItem ya debounced (quantity<=0 significa "sacarlo del carrito",
  // mismo criterio que decrementar a 0 desde el catálogo). Actualiza SOLO la
  // línea `itemId` sobre `itemsRef.current` (el más reciente, no el `items`
  // capturado cuando arrancó este commit) -- nunca reemplaza el arreglo
  // entero con la respuesta puntual de esta mutación, así que el orden de
  // llegada entre dos commits concurrentes de líneas distintas ya no importa.
  async function commitItemQuantity(itemId: string, quantity: number) {
    if (!token) return
    try {
      const res = quantity <= 0 ? await removeStorefrontCartItem(token, itemId) : await updateStorefrontCartItem(token, itemId, quantity)
      const match = res.items.find((item) => item.id === itemId)
      const current = itemsRef.current
      const next = match
        ? current.some((item) => item.id === itemId)
          ? current.map((item) => (item.id === itemId ? match : item))
          : [...current, match]
        : current.filter((item) => item.id !== itemId)
      itemsRef.current = next
      setItems(next)
      refreshCartCount(next.reduce((sum, item) => sum + item.quantity, 0))
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.cart.checkoutError'))
    }
  }

  async function handleRequestOtp() {
    if (!token) return
    setBusy(true)
    try {
      await requestCheckoutOtp(token, phone)
      setStep('otp')
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.cart.otpError'))
    } finally {
      setBusy(false)
    }
  }

  // Acepta el código como parámetro (con `otp` state como default) para que
  // el auto-submit de InputOTP (onComplete, ver abajo) pueda pasar el valor
  // recién completado directo, sin depender de que el state ya se haya
  // asentado en este mismo ciclo de eventos.
  async function handleVerifyOtp(code: string = otp) {
    if (!token) return
    setBusy(true)
    try {
      const res = await verifyCheckoutOtp(token, phone, code)
      if (res.client) {
        setFullName(res.client.full_name)
        if (res.client.document_type) setDocumentType(res.client.document_type)
        if (res.client.document_number) setDocumentNumber(res.client.document_number)
      }
      setSavedAddresses(res.addresses)
      // Mismo criterio que shippingAddresses/billingAddresses de abajo: la
      // preselección mira TODAS las direcciones guardadas, no solo las
      // marcadas para ese rol puntual.
      const defaultAddressId = res.addresses.find((a) => a.is_default)?.id ?? res.addresses[0]?.id ?? null
      setSelectedShippingId(defaultAddressId)
      setSelectedBillingId(defaultAddressId)
      setStep('details')
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.cart.otpError'))
    } finally {
      setBusy(false)
    }
  }

  // Deliberadamente NO se filtra por is_shipping/is_billing acá -- a
  // diferencia de OrderDetail.tsx (portal interno, un agente eligiendo entre
  // direcciones ya clasificadas de un cliente conocido), en el checkout de
  // la tienda el cliente ve TODAS sus direcciones guardadas en los dos
  // pickers. Bug real encontrado probando con un cliente real: una dirección
  // cargada por la IA en una conversación de WhatsApp había quedado
  // is_billing=true/is_shipping=false, así que el picker de envío la ocultaba
  // por completo aunque el cliente la tenía guardada -- para una compra
  // rápida, minimizar fricción (mostrar todo lo que tiene) importa más que
  // respetar esa clasificación interna.
  const shippingAddresses = savedAddresses
  const billingAddresses = savedAddresses
  const selectedShipping = selectedShippingId ? shippingAddresses.find((a) => a.id === selectedShippingId) : undefined
  const usingNewShipping = shippingAddresses.length === 0 || !selectedShipping
  const selectedBilling = selectedBillingId ? billingAddresses.find((a) => a.id === selectedBillingId) : undefined
  const usingNewBilling = !billingSameAsShipping && (billingAddresses.length === 0 || !selectedBilling)

  const shippingValid = usingNewShipping ? !!shippingLine1 && !!shippingCity : true
  const billingValid = billingSameAsShipping || (usingNewBilling ? !!billingLine1 && !!billingCity : true)

  const redirectUrl = `${window.location.origin}/tienda/${slug}/carrito?payment=return`

  // Handler final de un resultado de pago (venga de submitCheckout, cuando
  // solo hay un método disponible y ya se resolvió solo, o de
  // handleSelectPaymentMethod) -- un solo lugar para la decisión
  // choose_payment vs success, en vez de duplicarla en los dos.
  function applyCheckoutResult(res: CheckoutResult) {
    setResult(res)
    if (res.payment_options && res.payment_options.length > 0) {
      setStep('choose_payment')
    } else {
      refreshCartCount([])
      if (res.payment_method !== 'wompi') clearStorefrontCartToken(slug)
      setStep('success')
    }
  }

  async function submitCheckout() {
    if (!token) return
    setBusy(true)
    try {
      const shippingAddress: CheckoutAddressInput = usingNewShipping
        ? { line1: shippingLine1, city: shippingCity, state_province: shippingStateProvince || undefined }
        : { line1: selectedShipping!.line1, city: selectedShipping!.city ?? '', state_province: selectedShipping!.state_province ?? undefined }

      const billingAddress: CheckoutAddressInput = billingSameAsShipping
        ? shippingAddress
        : usingNewBilling
          ? { line1: billingLine1, city: billingCity, state_province: billingStateProvince || undefined }
          : { line1: selectedBilling!.line1, city: selectedBilling!.city ?? '', state_province: selectedBilling!.state_province ?? undefined }

      // Se toma ANTES de mandar el checkout -- ver el comentario de
      // OrderSummary arriba sobre por qué no alcanza con `items`/`total`.
      const summary: OrderSummary = {
        items: items ?? [],
        total,
        fullName,
        phone,
        shippingAddress: { line1: shippingAddress.line1, city: shippingAddress.city, state_province: shippingAddress.state_province ?? null },
        billingAddress: { line1: billingAddress.line1, city: billingAddress.city, state_province: billingAddress.state_province ?? null },
        billingSameAsShipping,
      }

      const res = await checkoutStorefrontCart({
        session_token: token,
        full_name: fullName,
        phone,
        document_type: documentType,
        document_number: documentNumber || undefined,
        address_id: usingNewShipping ? undefined : selectedShipping!.id,
        address: usingNewShipping ? shippingAddress : undefined,
        billing_same_as_shipping: billingSameAsShipping,
        billing_address_id: !billingSameAsShipping && !usingNewBilling ? selectedBilling!.id : undefined,
        billing_address: !billingSameAsShipping && usingNewBilling ? billingAddress : undefined,
        // Vuelve a esta misma página -- pedido explícito del usuario. El
        // token del carrito NO se limpia acá abajo cuando el método es
        // Wompi: tiene que sobrevivir el viaje de ida y vuelta a la página
        // externa de Wompi para que, al volver, esta página pueda consultar
        // get_order_status con ese mismo token (ver el efecto de arriba).
        redirect_url: redirectUrl,
      })
      setOrderSummary(summary)
      applyCheckoutResult(res)
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.cart.checkoutError'))
    } finally {
      setBusy(false)
    }
  }

  // Paso 2 cuando checkout devolvió payment_options (más de un método
  // disponible) -- el pedido YA se creó y el carrito YA quedó "converted" en
  // submitCheckout. Bug real encontrado: esto antes volvía a llamar
  // checkoutStorefrontCart, que choca con "Este carrito ya fue completado"
  // (assertCartOpen del lado del backend) porque el carrito no está más
  // "active" -- select_payment_method es la acción nueva que resuelve el
  // pago sobre el pedido ya existente sin intentar recrear nada.
  async function handleSelectPaymentMethod(paymentMethod: 'wompi' | 'credito') {
    if (!token) return
    setBusy(true)
    try {
      const res = await selectStorefrontPaymentMethod({ session_token: token, payment_method: paymentMethod, redirect_url: redirectUrl })
      applyCheckoutResult(res)
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.cart.checkoutError'))
    } finally {
      setBusy(false)
    }
  }

  if (paymentReturn) {
    return <PaymentReturnScreen state={paymentReturn} slug={slug} />
  }

  if (items === null) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  if (step === 'success' && result && orderSummary) {
    return <OrderSuccessSummary result={result} summary={orderSummary} />
  }

  if (step === 'choose_payment' && result) {
    return (
      <div className="mx-auto max-w-md space-y-3 rounded-xl border border-border bg-card p-6">
        <h1 className="text-lg font-bold text-foreground">{t('storefront.cart.choosePayment')}</h1>
        {result.payment_options?.includes('wompi') && (
          <Button className="w-full" disabled={busy} onClick={() => handleSelectPaymentMethod('wompi')}>
            {t('storefront.cart.payWithWompi')}
          </Button>
        )}
        {result.payment_options?.includes('credito') && (
          <Button variant="secondary" className="w-full" disabled={busy} onClick={() => handleSelectPaymentMethod('credito')}>
            {t('storefront.cart.payWithCredit')}
          </Button>
        )}
      </div>
    )
  }

  if (items.length === 0) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm text-muted-foreground">{t('storefront.cart.empty')}</p>
        <Link to={`/tienda/${slug}`} className="mt-2 inline-block text-sm font-medium text-primary hover:underline">
          {t('storefront.cart.backToCatalog')}
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        {items.map((item) => (
          <CartLineItem key={item.id} item={item} onCommit={commitItemQuantity} />
        ))}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-sm font-medium text-muted-foreground">{t('storefront.cart.total')}</span>
          <span className="text-lg font-bold text-foreground">{formatCurrency(total)}</span>
        </div>
      </div>

      {step === 'cart' && (
        <Button size="lg" className="w-full" onClick={() => setStep('identify')}>
          {t('storefront.cart.continueToCheckout')}
        </Button>
      )}

      {step === 'identify' && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="space-y-1.5">
            <Label>{t('storefront.cart.documentLabel')}</Label>
            <div className="flex gap-2">
              <Select value={documentType} onValueChange={setDocumentType}>
                <SelectTrigger className="h-9 w-28 shrink-0 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map((d) => (
                    <SelectItem key={d.value} value={d.value}>
                      {t(d.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={documentNumber}
                onChange={(e) => setDocumentNumber(e.target.value)}
                placeholder={t('storefront.cart.documentPlaceholder')}
                inputMode="numeric"
                className="flex-1"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{t('storefront.cart.phoneLabel')}</Label>
            <PhoneInput value={phone} onChange={setPhone} />
          </div>
          <p className="text-xs text-muted-foreground">{t('storefront.cart.otpExplainer')}</p>
          <Button size="lg" className="w-full" disabled={busy || !phone || !documentNumber} onClick={handleRequestOtp}>
            {busy ? t('common.actions.saving') : t('storefront.cart.sendCode')}
          </Button>
        </div>
      )}

      {step === 'otp' && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <Label>{t('storefront.cart.otpLabel')}</Label>
          <InputOTP
            maxLength={6}
            value={otp}
            onChange={setOtp}
            onComplete={(code) => handleVerifyOtp(code)}
            disabled={busy}
            pattern={REGEXP_ONLY_DIGITS}
            containerClassName="justify-center"
          >
            <InputOTPGroup>
              <InputOTPSlot index={0} />
              <InputOTPSlot index={1} />
              <InputOTPSlot index={2} />
              <InputOTPSlot index={3} />
              <InputOTPSlot index={4} />
              <InputOTPSlot index={5} />
            </InputOTPGroup>
          </InputOTP>
          <Button size="lg" className="w-full" disabled={busy || otp.length < 6} onClick={() => handleVerifyOtp()}>
            {busy ? t('common.actions.saving') : t('storefront.cart.verifyCode')}
          </Button>
        </div>
      )}

      {step === 'details' && (
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="space-y-1.5">
            <Label>{t('storefront.cart.fullName')}</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>

          <div className="space-y-2">
            <Label>{t('storefront.cart.shippingAddress')}</Label>
            <AddressPicker
              addresses={shippingAddresses}
              selectedId={selectedShippingId}
              onSelectId={setSelectedShippingId}
              usingNew={usingNewShipping}
              line1={shippingLine1}
              onLine1Change={setShippingLine1}
              city={shippingCity}
              onCityChange={setShippingCity}
              stateProvince={shippingStateProvince}
              onStateProvinceChange={setShippingStateProvince}
            />
          </div>

          <div className="space-y-2 border-t border-border pt-3">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={billingSameAsShipping} onCheckedChange={(checked) => setBillingSameAsShipping(checked === true)} />
              {t('storefront.cart.billingSameAsShipping')}
            </label>

            {!billingSameAsShipping && (
              <div className="space-y-2 pt-1">
                <Label>{t('storefront.cart.billingAddress')}</Label>
                <AddressPicker
                  addresses={billingAddresses}
                  selectedId={selectedBillingId}
                  onSelectId={setSelectedBillingId}
                  usingNew={usingNewBilling}
                  line1={billingLine1}
                  onLine1Change={setBillingLine1}
                  city={billingCity}
                  onCityChange={setBillingCity}
                  stateProvince={billingStateProvince}
                  onStateProvinceChange={setBillingStateProvince}
                />
              </div>
            )}
          </div>

          <Button size="lg" className="w-full" disabled={busy || !fullName || !shippingValid || !billingValid} onClick={() => submitCheckout()}>
            {busy ? t('common.actions.saving') : t('storefront.cart.placeOrder')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** Picker de una dirección (envío o facturación, según quién lo use) --
 * tarjetas de las guardadas + una opción "Usar una dirección nueva" que
 * revela el formulario manual. Compartido entre envío y facturación para no
 * duplicar este bloque de UI dos veces. */
function AddressPicker({
  addresses,
  selectedId,
  onSelectId,
  usingNew,
  line1,
  onLine1Change,
  city,
  onCityChange,
  stateProvince,
  onStateProvinceChange,
}: {
  addresses: StorefrontSavedAddress[]
  selectedId: string | null
  onSelectId: (id: string | null) => void
  usingNew: boolean
  line1: string
  onLine1Change: (value: string) => void
  city: string
  onCityChange: (value: string) => void
  stateProvince: string
  onStateProvinceChange: (value: string) => void
}) {
  const { t } = useLanguage()

  return (
    <div className="space-y-2">
      {addresses.length > 0 && (
        <div className="space-y-2">
          {addresses.map((addr) => (
            <button
              key={addr.id}
              type="button"
              onClick={() => onSelectId(addr.id)}
              className={`flex w-full items-start gap-2.5 rounded-lg border p-3 text-left text-sm transition-colors ${
                selectedId === addr.id ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
              }`}
            >
              <MapPinIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="font-medium text-foreground">
                  {addr.line1}
                  {addr.line2 ? `, ${addr.line2}` : ''}
                </p>
                <p className="text-xs text-muted-foreground">{[addr.city, addr.state_province].filter(Boolean).join(', ')}</p>
              </div>
              {selectedId === addr.id && <CheckIcon className="mt-0.5 size-4 shrink-0 text-primary" />}
            </button>
          ))}
          <button
            type="button"
            onClick={() => onSelectId(null)}
            className={`flex w-full items-center gap-2.5 rounded-lg border p-3 text-left text-sm transition-colors ${
              usingNew ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted'
            }`}
          >
            <PlusIcon className="size-4 shrink-0 text-muted-foreground" />
            <span className="font-medium text-foreground">{t('storefront.cart.newAddress')}</span>
          </button>
        </div>
      )}

      {usingNew && (
        <div className="space-y-3 rounded-lg border border-dashed border-border p-3">
          <div className="space-y-1.5">
            <Label>{t('storefront.cart.address')}</Label>
            <Input value={line1} onChange={(e) => onLine1Change(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('storefront.cart.city')}</Label>
              <Input value={city} onChange={(e) => onCityChange(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('storefront.cart.stateProvince')}</Label>
              <Input value={stateProvince} onChange={(e) => onStateProvinceChange(e.target.value)} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Pantalla de "listo" completa -- pedido explícito del usuario: antes solo
 * decía "Listo", sin ítems, cantidades, total ni direcciones. `summary` es
 * el snapshot tomado en `submitCheckout` (ver la interfaz arriba), no el
 * `items`/`total` en vivo del carrito (que para este momento ya está
 * vacío/limpiado). Facturación se muestra siempre, aparte de envío -- si
 * coinciden se aclara con una nota en vez de repetir la dirección entera. */
function OrderSuccessSummary({ result, summary }: { result: CheckoutResult; summary: OrderSummary }) {
  const { t } = useLanguage()

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="space-y-1 rounded-xl border border-border bg-card p-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
          <CheckIcon className="size-6 text-primary" />
        </div>
        <h1 className="text-lg font-bold text-foreground">{t('storefront.cart.successTitle', { code: result.order_code })}</h1>
        <p className="text-sm text-muted-foreground">{t('storefront.cart.successSubtitle')}</p>
      </div>

      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <p className="text-sm font-semibold text-foreground">{t('storefront.cart.orderSummary')}</p>
        <div className="space-y-2.5">
          {summary.items.map((item) => (
            <div key={item.id} className="flex items-center gap-3">
              <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md bg-muted">
                <StorefrontImage src={item.image_url} alt={item.name} className="h-full w-full" iconClassName="size-3" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{item.name}</p>
                {item.variant_label && <p className="text-xs text-muted-foreground">{item.variant_label}</p>}
              </div>
              <p className="shrink-0 text-xs text-muted-foreground">x{item.quantity}</p>
              <p className="shrink-0 text-sm font-medium text-foreground">{formatCurrency(item.subtotal)}</p>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-border pt-2.5">
          <span className="text-sm font-medium text-muted-foreground">{t('storefront.cart.total')}</span>
          <span className="text-base font-bold text-foreground">{formatCurrency(summary.total)}</span>
        </div>
      </div>

      <div className="space-y-1 rounded-xl border border-border bg-card p-4 text-sm">
        <p className="font-semibold text-foreground">{t('storefront.cart.shippingAddress')}</p>
        <p className="text-muted-foreground">
          {summary.fullName} · {summary.phone}
        </p>
        <p className="text-muted-foreground">{summary.shippingAddress.line1}</p>
        <p className="text-muted-foreground">{[summary.shippingAddress.city, summary.shippingAddress.state_province].filter(Boolean).join(', ')}</p>
      </div>

      <div className="space-y-1 rounded-xl border border-border bg-card p-4 text-sm">
        <p className="font-semibold text-foreground">{t('storefront.cart.billingAddress')}</p>
        {summary.billingSameAsShipping ? (
          <p className="text-muted-foreground">{t('storefront.cart.sameAsShippingNote')}</p>
        ) : (
          <>
            <p className="text-muted-foreground">{summary.billingAddress.line1}</p>
            <p className="text-muted-foreground">{[summary.billingAddress.city, summary.billingAddress.state_province].filter(Boolean).join(', ')}</p>
          </>
        )}
      </div>

      {(result.payment_method || result.payment_pending) && (
        <div className="rounded-xl border border-border bg-card p-4 text-center">
          {result.payment_method === 'wompi' && result.checkout_url && (
            <>
              <p className="text-sm text-muted-foreground">{t('storefront.cart.payWithWompi')}</p>
              <Button className="mt-2 w-full" onClick={() => window.location.assign(result.checkout_url!)}>
                {t('storefront.cart.goToPayment')}
              </Button>
            </>
          )}
          {result.payment_method === 'credito' && <p className="text-sm text-muted-foreground">{t('storefront.cart.chargedToCredit')}</p>}
          {result.payment_pending && <p className="text-sm text-muted-foreground">{t('storefront.cart.paymentPending')}</p>}
        </div>
      )}
    </div>
  )
}

/** Lo que se ve al volver del checkout externo de Wompi -- reemplaza por
 * completo la vista normal del carrito mientras dure. `state` es 'checking'
 * (reintentando get_order_status), 'timeout' (se agotaron los reintentos sin
 * confirmación -- el webhook puede tardar más que el redirect, no es un
 * error) o el OrderStatusResult ya confirmado. */
function PaymentReturnScreen({ state, slug }: { state: OrderStatusResult | 'checking' | 'timeout'; slug: string }) {
  const { t } = useLanguage()

  if (state === 'checking') {
    return (
      <div className="mx-auto max-w-md space-y-3 rounded-xl border border-border bg-card p-6 text-center">
        <Loader2Icon className="mx-auto size-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">{t('storefront.cart.paymentReturnChecking')}</p>
      </div>
    )
  }

  if (state === 'timeout') {
    return (
      <div className="mx-auto max-w-md space-y-3 rounded-xl border border-border bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">{t('storefront.cart.paymentReturnTimeout')}</p>
        <Link to={`/tienda/${slug}`} className="inline-block text-sm font-medium text-primary hover:underline">
          {t('storefront.cart.backToCatalog')}
        </Link>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md space-y-4">
      <div className="space-y-1 rounded-xl border border-border bg-card p-6 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
          <CheckIcon className="size-6 text-primary" />
        </div>
        <h1 className="text-lg font-bold text-foreground">{t('storefront.cart.paymentReturnConfirmed', { code: state.order_code })}</h1>
        <p className="text-sm text-muted-foreground">{formatCurrency(state.total)}</p>
      </div>
      <Link to={`/tienda/${slug}`} className="block text-center text-sm font-medium text-primary hover:underline">
        {t('storefront.cart.backToCatalog')}
      </Link>
    </div>
  )
}

/** Una fila de línea del carrito -- dueña de su propio `useDebouncedQuantity`
 * (cada ítem necesita su propio timer/estado local independiente del resto).
 * El número se puede tipear directo, no solo +/- (pedido explícito del
 * usuario), y el borde + el ícono girando en la esquina avisan que hay un
 * cambio guardándose -- sin deshabilitar los botones mientras tanto, para
 * que clickear varias veces seguidas se sienta instantáneo en vez de tener
 * que esperar cada viaje de red antes del próximo click. "Quitar" pasa por
 * `flushNow` (no por el debounce): es una acción puntual, no debería quedar
 * en cola detrás de un cambio de cantidad pendiente para el mismo ítem. */
function CartLineItem({ item, onCommit }: { item: StorefrontCartItem; onCommit: (itemId: string, quantity: number) => Promise<void> }) {
  const { value, saving, setValue, nudge, flushNow } = useDebouncedQuantity(item.quantity, (quantity) => onCommit(item.id, quantity))

  return (
    <div className="flex items-center gap-3">
      <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">
        <StorefrontImage src={item.image_url} alt={item.name} className="h-full w-full" iconClassName="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
        {item.variant_label && <p className="text-xs text-muted-foreground">{item.variant_label}</p>}
        <p className="text-sm text-primary">{formatCurrency(item.unit_price)}</p>
      </div>
      <div className={`relative flex items-center rounded-lg border transition-colors ${saving ? 'border-primary/60' : 'border-border'}`}>
        <button type="button" onClick={() => nudge(-1)} className="px-2.5 py-1 text-foreground">
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          className="w-9 border-0 bg-transparent text-center text-sm text-foreground outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
        />
        <button type="button" onClick={() => nudge(1)} className="px-2.5 py-1 text-foreground">
          +
        </button>
        {saving && (
          <span className="absolute -top-1.5 -right-1.5 flex size-3.5 items-center justify-center rounded-full bg-background">
            <Loader2Icon className="size-3 animate-spin text-primary" />
          </span>
        )}
      </div>
      <button type="button" onClick={() => flushNow(0)} className="text-muted-foreground hover:text-destructive">
        <TrashIcon className="size-3.5" />
      </button>
    </div>
  )
}
