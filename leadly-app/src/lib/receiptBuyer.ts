import type { ClientBillingProfile, ContactAddress, FulfillmentMethod } from '../types/domain'

/** Datos del bloque «cliente» de un ticket. Reglas (presentación, no negocio):
 * - Nombre y documento: los del perfil de facturación elegido si hay uno (es
 *   el comprador de la factura); si no, los del cliente.
 * - Dirección: el destino de entrega solo si el pedido es a domicilio; si no
 *   es a domicilio, el domicilio fiscal del perfil (si hay perfil); si no,
 *   ninguna. Nunca se imprime una dirección «de facturación» suelta. */
export interface ReceiptBuyerInput {
  contact: { full_name: string; document_number: string | null } | null
  fulfillment_method?: FulfillmentMethod | null
  shipping_address?: Pick<ContactAddress, 'line1' | 'city' | 'country'> | null
  billing_profile?: Pick<ClientBillingProfile, 'legal_name' | 'document_number' | 'address_line1' | 'city' | 'country'> | null
}

export interface ReceiptBuyer {
  name: string
  document: string | null
  address: string | null
}

export function receiptBuyer(order: ReceiptBuyerInput): ReceiptBuyer | null {
  if (!order.contact) return null
  const profile = order.billing_profile ?? null
  const delivery = order.fulfillment_method === 'delivery' ? (order.shipping_address ?? null) : null
  const parts = delivery
    ? [delivery.line1, delivery.city, delivery.country]
    : profile
      ? [profile.address_line1, profile.city, profile.country]
      : []
  const address = parts.filter(Boolean).join(', ')
  return {
    name: profile?.legal_name?.trim() || order.contact.full_name,
    document: profile?.document_number?.trim() || order.contact.document_number || null,
    address: address || null,
  }
}
