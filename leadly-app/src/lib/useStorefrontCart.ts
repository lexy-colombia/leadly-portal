import { useEffect, useMemo, useRef, useState } from 'react'
import { addToStorefrontCart, getStorefrontCart, removeStorefrontCartItem, updateStorefrontCartItem, type StorefrontCartItem } from './api/storefront'
import type { OrderTotalsBreakdown } from './api/orders'
import { getStorefrontCartToken, setStorefrontCartToken } from './storefrontCart'

/** Estado + mutaciones del carrito de la tienda pública, extraído de
 * StorefrontCatalog.tsx para que StorefrontProductDetail.tsx (panel "Tu
 * pedido" + grilla de "también te puede interesar") pueda compartir
 * exactamente la misma lógica -- en particular las dos condiciones de
 * carrera ya resueltas ahí (ver comentarios de itemsRef/pendingCartTokenRef
 * abajo), en vez de reimplementarlas o dejar el detalle de producto con un
 * carrito desincronizado del resto de la tienda. */
export function useStorefrontCart(slug: string, refreshCartCount: (items?: StorefrontCartItem[] | number) => void, onError: (err: unknown) => void) {
  // itemsRef es el espejo síncrono que commitCartQuantity necesita para no
  // quedar atado al closure (posiblemente viejo) de cuándo se disparó el
  // commit -- dos productos distintos agregándose en paralelo pisaban todo
  // el arreglo con su propia foto parcial si se leía `items` en vez de esto.
  const [items, setItems] = useState<StorefrontCartItem[]>([])
  const itemsRef = useRef<StorefrontCartItem[]>([])
  const [totals, setTotals] = useState<OrderTotalsBreakdown | null>(null)
  // Cuando todavía no existe ningún carrito, el PRIMER add_to_cart que sale
  // es el que efectivamente lo crea -- si dos adds distintos salen casi al
  // mismo tiempo antes de que ese primer request vuelva con un
  // session_token, los dos mandan session_token=null y el backend crea DOS
  // carritos separados. Este ref es la promesa del primer add en vuelo:
  // cualquier otro commit que también encuentre el token vacío espera ESTE
  // resultado en vez de disparar su propio carrito nuevo.
  const pendingCartTokenRef = useRef<Promise<string> | null>(null)

  const itemsByKey = useMemo(() => {
    const map = new Map<string, StorefrontCartItem>()
    for (const item of items) map.set(item.variant_id ?? item.product_id, item)
    return map
  }, [items])

  // Solo al montar/cambiar de tienda -- después de cada mutación, el propio
  // `items` que devuelve esa llamada alcanza para actualizar el estado
  // local, sin otro round-trip a get_cart.
  useEffect(() => {
    const token = getStorefrontCartToken(slug)
    if (!token) {
      itemsRef.current = []
      setItems([])
      setTotals(null)
      return
    }
    getStorefrontCart(token)
      .then((res) => {
        itemsRef.current = res.items
        setItems(res.items)
        setTotals(res.totals ?? null)
      })
      .catch(() => {
        itemsRef.current = []
        setItems([])
        setTotals(null)
      })
  }, [slug])

  /** Único punto de guardado real para la cantidad de un producto/variante
   * en el carrito -- `quantity` es la cantidad ABSOLUTA final deseada para
   * esa línea (key = variantId ?? productId), no un delta. Decide
   * add_to_cart (todavía no había ítem) vs update/remove_cart_item (ya
   * había uno) mirando itemsRef.current en el momento en que efectivamente
   * dispara, no en el momento del primer click.
   *
   * Devuelve si la mutación se guardó realmente -- el caller original
   * (ProductCardAction/VariantRow vía useDebouncedQuantity) lo ignora, pero
   * StorefrontProductDetail.tsx lo necesita para saber si mostrar el
   * feedback de "Agregado" o no. Nunca relanza el error (además de
   * reportarlo con onError): un componente debounced que llama esto sin
   * try/catch propio dejaría una promesa rechazada sin manejar. */
  async function commitCartQuantity(key: string, productId: string, variantId: string | undefined, quantity: number): Promise<boolean> {
    const startItems = itemsRef.current
    const existing = startItems.find((item) => (item.variant_id ?? item.product_id) === key)
    try {
      let freshItems: StorefrontCartItem[]
      let freshTotals: OrderTotalsBreakdown
      if (existing) {
        const token = getStorefrontCartToken(slug)
        if (!token) return false
        const res = quantity <= 0 ? await removeStorefrontCartItem(token, existing.id) : await updateStorefrontCartItem(token, existing.id, quantity)
        freshItems = res.items
        freshTotals = res.totals
      } else if (quantity > 0) {
        let sessionToken = getStorefrontCartToken(slug)
        if (!sessionToken && pendingCartTokenRef.current) {
          sessionToken = await pendingCartTokenRef.current
        }
        const addPromise = addToStorefrontCart({ slug, session_token: sessionToken, product_id: productId, variant_id: variantId, quantity }).then((result) => {
          setStorefrontCartToken(slug, result.session_token)
          return result
        })
        if (!sessionToken) {
          const tokenPromise = addPromise.then((result) => result.session_token)
          pendingCartTokenRef.current = tokenPromise
          tokenPromise.finally(() => {
            if (pendingCartTokenRef.current === tokenPromise) pendingCartTokenRef.current = null
          })
        }
        const result = await addPromise
        freshItems = result.items
        freshTotals = result.totals
      } else {
        return false
      }

      // Se mezcla sobre itemsRef.current LEÍDO RECIÉN ACÁ (después del
      // await), nunca sobre `startItems` -- otro commit concurrente (un
      // producto DISTINTO) puede haber actualizado itemsRef.current mientras
      // este esperaba su propia red, y mezclar sobre `startItems` pisaría esa
      // línea ajena en vez de sumarse a ella.
      const latest = itemsRef.current
      const stillExisting = latest.find((item) => (item.variant_id ?? item.product_id) === key)
      const match = freshItems.find((item) => (item.variant_id ?? item.product_id) === key)
      const next = stillExisting
        ? match
          ? latest.map((item) => (item.id === stillExisting.id ? match : item))
          : latest.filter((item) => item.id !== stillExisting.id)
        : match
          ? [...latest, match]
          : latest
      itemsRef.current = next
      setItems(next)
      setTotals(freshTotals)
      refreshCartCount(next.reduce((sum, item) => sum + item.quantity, 0))
      return true
    } catch (err) {
      onError(err)
      return false
    }
  }

  /** Misma idea que commitCartQuantity pero para una fila ya identificada
   * por su itemId (panel "Tu pedido", donde cada línea ya sabe su propio id
   * de cart_items en vez de tener que resolverlo por producto/variante). */
  async function commitPanelQuantity(itemId: string, quantity: number) {
    try {
      const token = getStorefrontCartToken(slug)
      if (!token) return
      const res = quantity <= 0 ? await removeStorefrontCartItem(token, itemId) : await updateStorefrontCartItem(token, itemId, quantity)
      const current = itemsRef.current
      const match = res.items.find((item) => item.id === itemId)
      const next = match ? current.map((item) => (item.id === itemId ? match : item)) : current.filter((item) => item.id !== itemId)
      itemsRef.current = next
      setItems(next)
      setTotals(res.totals)
      refreshCartCount(next.reduce((sum, item) => sum + item.quantity, 0))
    } catch (err) {
      onError(err)
    }
  }

  function handleCartCleared(result: { items: StorefrontCartItem[]; totals: OrderTotalsBreakdown }) {
    itemsRef.current = result.items
    setItems(result.items)
    setTotals(result.totals)
    refreshCartCount(result.items)
  }

  return { items, itemsByKey, totals, commitCartQuantity, commitPanelQuantity, handleCartCleared }
}
