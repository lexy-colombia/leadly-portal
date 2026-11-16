/** Destino de entrega de UN SOLO USO de un pedido/carrito (no entra a la
 * libreta de direcciones del cliente). Contrato: calculate-order, campo
 * `shipping_destination`. El servidor valida (línea 1 real, pertenencia,
 * DANE cuando se exija); acá solo se arma/lee la forma. */
export interface ShippingDestination {
  recipient_name?: string | null
  phone?: string | null
  line1: string
  line2?: string | null
  city?: string | null
  state_province?: string | null
  state_code?: string | null
  city_code?: string | null
  postal_code?: string | null
  notes?: string | null
  country?: string | null
}

const KEYS = ['recipient_name', 'phone', 'line1', 'line2', 'city', 'state_province', 'state_code', 'city_code', 'postal_code', 'notes', 'country'] as const

/** Lee el destino puntual de un `shipping_snapshot` devuelto por el servidor:
 * solo cuando no hay dirección guardada y el snapshot está marcado `one_off`. */
export function destinationFromSnapshot(snapshot: Record<string, unknown> | null | undefined): ShippingDestination | null {
  if (!snapshot || snapshot.one_off !== true || snapshot.address_id) return null
  const dest: Record<string, string | null> = {}
  for (const key of KEYS) {
    const v = snapshot[key]
    dest[key] = typeof v === 'string' && v.trim() !== '' ? v : null
  }
  return { ...dest, line1: dest.line1 ?? '' } as ShippingDestination
}

/** Cuerpo a enviar: solo las claves conocidas, con trim y sin vacíos. */
export function destinationPayload(dest: ShippingDestination): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of KEYS) {
    const v = dest[key]
    if (typeof v === 'string' && v.trim() !== '') out[key] = v.trim()
  }
  return out
}

/** Texto corto de una línea para resúmenes. */
export function formatDestination(dest: ShippingDestination): string {
  return [dest.line1, dest.line2, dest.city, dest.state_province].filter((p) => p && p.trim() !== '').join(', ')
}

/** Dos destinos puntuales equivalentes (para el snapshot de autoguardado). */
export function sameDestination(a: ShippingDestination | null, b: ShippingDestination | null): boolean {
  return JSON.stringify(a ? destinationPayload(a) : null) === JSON.stringify(b ? destinationPayload(b) : null)
}

/** Parte de un autoguardado/guardado que decide el destino. Reglas del
 * contrato: un destino puntual activo se reenvía en cada guardado y NO va junto
 * a `shipping_address_id`; elegir una dirección guardada (o quitar la
 * modalidad domicilio) limpia el puntual; sin nada, `shipping_address_id:
 * null` solo no lo toca, por eso al vaciar se manda `shipping_destination:
 * null` explícito. */
export function destinationFields(input: {
  delivery: boolean
  shippingAddressId: string
  oneOff: ShippingDestination | null
}): { shipping_address_id?: string | null; shipping_destination?: Record<string, string> | null } {
  if (!input.delivery) return { shipping_address_id: null, shipping_destination: null }
  if (input.oneOff) return { shipping_destination: destinationPayload(input.oneOff) }
  if (input.shippingAddressId) return { shipping_address_id: input.shippingAddressId }
  return { shipping_address_id: null, shipping_destination: null }
}
