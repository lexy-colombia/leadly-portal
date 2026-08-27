import { useEffect, useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { TrashIcon } from 'lucide-react'
import { useLanguage } from '../../contexts/LanguageContext'
import {
  checkoutStorefrontCart,
  getStorefrontCart,
  removeStorefrontCartItem,
  requestCheckoutOtp,
  updateStorefrontCartItem,
  verifyCheckoutOtp,
  type CheckoutResult,
  type StorefrontCartItem,
} from '../../lib/api/storefront'
import { getStorefrontCartToken, clearStorefrontCartToken } from '../../lib/storefrontCart'
import type { StorefrontOutletContext } from '../../layouts/StorefrontLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { PhoneInput } from '@/components/molecules'
import { StorefrontImage } from '@/components/storefront/StorefrontImage'

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(value)
}

type Step = 'cart' | 'phone' | 'otp' | 'details' | 'choose_payment' | 'success'

/** Carrito + checkout en dos pasos (verificar teléfono, después nombre/
 * dirección/pago) -- ver CLAUDE.md, "Verificación de identidad": sin esto,
 * cualquiera podría escribir el teléfono de un cliente real y comprar a su
 * nombre (grave si tiene crédito habilitado). */
export function StorefrontCart() {
  const { slug, refreshCartCount, showError } = useOutletContext<StorefrontOutletContext>()
  const { t } = useLanguage()
  const token = getStorefrontCartToken(slug)

  const [items, setItems] = useState<StorefrontCartItem[] | null>(null)
  const [step, setStep] = useState<Step>('cart')
  const [phone, setPhone] = useState('')
  const [otp, setOtp] = useState('')
  const [fullName, setFullName] = useState('')
  const [line1, setLine1] = useState('')
  const [city, setCity] = useState('')
  const [stateProvince, setStateProvince] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<CheckoutResult | null>(null)

  useEffect(() => {
    if (!token) {
      setItems([])
      return
    }
    getStorefrontCart(token)
      .then((res) => setItems(res.items))
      .catch(() => setItems([]))
  }, [token])

  const total = (items ?? []).reduce((sum, item) => sum + item.subtotal, 0)

  async function handleUpdateQuantity(itemId: string, quantity: number) {
    if (!token) return
    try {
      const res = await updateStorefrontCartItem(token, itemId, quantity)
      setItems(res.items)
      refreshCartCount()
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.cart.checkoutError'))
    }
  }

  async function handleRemove(itemId: string) {
    if (!token) return
    try {
      const res = await removeStorefrontCartItem(token, itemId)
      setItems(res.items)
      refreshCartCount()
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

  async function handleVerifyOtp() {
    if (!token) return
    setBusy(true)
    try {
      await verifyCheckoutOtp(token, phone, otp)
      setStep('details')
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.cart.otpError'))
    } finally {
      setBusy(false)
    }
  }

  async function submitCheckout(paymentMethod?: 'wompi' | 'credito') {
    if (!token) return
    setBusy(true)
    try {
      const res = await checkoutStorefrontCart({
        session_token: token,
        full_name: fullName,
        phone,
        address: { line1, city, state_province: stateProvince || undefined },
        payment_method: paymentMethod,
      })
      setResult(res)
      if (res.payment_options && res.payment_options.length > 0) {
        setStep('choose_payment')
      } else {
        clearStorefrontCartToken(slug)
        refreshCartCount()
        setStep('success')
      }
    } catch (err) {
      showError(err instanceof Error ? err.message : t('storefront.cart.checkoutError'))
    } finally {
      setBusy(false)
    }
  }

  if (items === null) {
    return (
      <div className="mx-auto max-w-2xl space-y-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    )
  }

  if (step === 'success' && result) {
    return (
      <div className="mx-auto max-w-md space-y-3 rounded-xl border border-border bg-card p-6 text-center">
        <h1 className="text-lg font-bold text-foreground">{t('storefront.cart.successTitle', { code: result.order_code })}</h1>
        {result.payment_method === 'wompi' && result.checkout_url && (
          <>
            <p className="text-sm text-muted-foreground">{t('storefront.cart.payWithWompi')}</p>
            <Button className="w-full" onClick={() => window.location.assign(result.checkout_url!)}>
              {t('storefront.cart.goToPayment')}
            </Button>
          </>
        )}
        {result.payment_method === 'credito' && <p className="text-sm text-muted-foreground">{t('storefront.cart.chargedToCredit')}</p>}
        {result.payment_pending && <p className="text-sm text-muted-foreground">{t('storefront.cart.paymentPending')}</p>}
      </div>
    )
  }

  if (step === 'choose_payment' && result) {
    return (
      <div className="mx-auto max-w-md space-y-3 rounded-xl border border-border bg-card p-6">
        <h1 className="text-lg font-bold text-foreground">{t('storefront.cart.choosePayment')}</h1>
        {result.payment_options?.includes('wompi') && (
          <Button className="w-full" disabled={busy} onClick={() => submitCheckout('wompi')}>
            {t('storefront.cart.payWithWompi')}
          </Button>
        )}
        {result.payment_options?.includes('credito') && (
          <Button variant="secondary" className="w-full" disabled={busy} onClick={() => submitCheckout('credito')}>
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
          <div key={item.id} className="flex items-center gap-3">
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-muted">
              <StorefrontImage src={item.image_url} alt={item.name} className="h-full w-full" iconClassName="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
              {item.variant_label && <p className="text-xs text-muted-foreground">{item.variant_label}</p>}
              <p className="text-sm text-primary">{formatCurrency(item.unit_price)}</p>
            </div>
            <div className="flex items-center rounded-lg border border-border">
              <button type="button" onClick={() => handleUpdateQuantity(item.id, item.quantity - 1)} disabled={item.quantity <= 1} className="px-2.5 py-1 text-foreground disabled:opacity-30">
                −
              </button>
              <span className="w-6 text-center text-sm">{item.quantity}</span>
              <button type="button" onClick={() => handleUpdateQuantity(item.id, item.quantity + 1)} className="px-2.5 py-1 text-foreground">
                +
              </button>
            </div>
            <button type="button" onClick={() => handleRemove(item.id)} className="text-muted-foreground hover:text-destructive">
              <TrashIcon className="size-3.5" />
            </button>
          </div>
        ))}
        <div className="flex items-center justify-between border-t border-border pt-3">
          <span className="text-sm font-medium text-muted-foreground">{t('storefront.cart.total')}</span>
          <span className="text-lg font-bold text-foreground">{formatCurrency(total)}</span>
        </div>
      </div>

      {step === 'cart' && (
        <Button size="lg" className="w-full" onClick={() => setStep('phone')}>
          {t('storefront.cart.continueToCheckout')}
        </Button>
      )}

      {step === 'phone' && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <Label>{t('storefront.cart.phoneLabel')}</Label>
          <PhoneInput value={phone} onChange={setPhone} />
          <p className="text-xs text-muted-foreground">{t('storefront.cart.otpExplainer')}</p>
          <Button size="lg" className="w-full" disabled={busy || !phone} onClick={handleRequestOtp}>
            {busy ? t('common.actions.saving') : t('storefront.cart.sendCode')}
          </Button>
        </div>
      )}

      {step === 'otp' && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <Label>{t('storefront.cart.otpLabel')}</Label>
          <Input value={otp} onChange={(e) => setOtp(e.target.value)} maxLength={6} inputMode="numeric" placeholder="123456" />
          <Button size="lg" className="w-full" disabled={busy || otp.length < 6} onClick={handleVerifyOtp}>
            {busy ? t('common.actions.saving') : t('storefront.cart.verifyCode')}
          </Button>
        </div>
      )}

      {step === 'details' && (
        <div className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="space-y-1.5">
            <Label>{t('storefront.cart.fullName')}</Label>
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>{t('storefront.cart.address')}</Label>
            <Input value={line1} onChange={(e) => setLine1(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>{t('storefront.cart.city')}</Label>
              <Input value={city} onChange={(e) => setCity(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>{t('storefront.cart.stateProvince')}</Label>
              <Input value={stateProvince} onChange={(e) => setStateProvince(e.target.value)} />
            </div>
          </div>
          <Button size="lg" className="w-full" disabled={busy || !fullName || !line1 || !city} onClick={() => submitCheckout()}>
            {busy ? t('common.actions.saving') : t('storefront.cart.placeOrder')}
          </Button>
        </div>
      )}
    </div>
  )
}
