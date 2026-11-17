import { supabase } from '../supabaseClient'
import type { ClientDeliveryAddress } from '../../types/domain'

export interface AddressInput {
  tenant_id: string
  contact_id: string
  label?: string | null
  recipient_name?: string | null
  phone?: string | null
  line1: string
  line2?: string | null
  city?: string | null
  state_province?: string | null
  // Código DANE (DIVIPOLA) de municipio/departamento -- ver co_geo.ts. La
  // DIAN los exige en la dirección de facturación del comprador cuando se
  // trata de una operación con Colombia (reglas FAK09/FAK29/FAK32, ver
  // buildInvoiceXml.ts). `city`/`state_province` siguen siendo el nombre
  // legible (autocompletado desde el catálogo al elegir), estas dos son
  // el código real que la DIAN valida.
  city_code?: string | null
  state_code?: string | null
  postal_code?: string | null
  country?: string | null
  notes?: string | null
  is_default?: boolean
}

export async function listAddressesForContact(contactId: string): Promise<ClientDeliveryAddress[]> {
  const { data, error } = await supabase
    .from('contact_addresses')
    .select('*')
    .eq('contact_id', contactId)
    .is('deleted_at', null)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

/** Código de la restricción única «una dirección no se repite dentro del
 * mismo cliente» (migración 20261112132000). */
const DUPLICATE_ADDRESS_CONSTRAINT = 'contact_addresses_unique_address_per_client'

export function isDuplicateAddressError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  return !!e && e.code === '23505' && (e.message ?? '').includes(DUPLICATE_ADDRESS_CONSTRAINT)
}

function normalizeAddressText(text: string | null | undefined): string {
  return (text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '')
}

/** Busca, entre las direcciones del cliente, la que coincide con la que se
 * intentó crear (misma línea 1 y 2, normalizadas). Solo se usa para
 * reutilizarla cuando el servidor rechazó el alta por duplicada (23505); la
 * regla de qué es «duplicada» es del servidor, esto solo la encuentra. */
export async function findExistingAddress(contactId: string, input: Pick<AddressInput, 'line1' | 'line2'>): Promise<ClientDeliveryAddress | null> {
  const list = await listAddressesForContact(contactId)
  const l1 = normalizeAddressText(input.line1)
  const l2 = normalizeAddressText(input.line2)
  return list.find((a) => normalizeAddressText(a.line1) === l1 && normalizeAddressText(a.line2) === l2) ?? null
}

/** Crea una dirección de entrega. Si el cliente ya la tiene (23505), NO
 * duplica: devuelve la existente (y, si se pidió, la deja como
 * predeterminada). */
export async function createAddress(input: AddressInput): Promise<ClientDeliveryAddress> {
  const { data, error } = await supabase.from('contact_addresses').insert(input).select().single()
  if (error) {
    if (isDuplicateAddressError(error)) {
      const existing = await findExistingAddress(input.contact_id, input)
      if (existing) {
        if (input.is_default && !existing.is_default) return updateAddress(existing.id, input.contact_id, { is_default: true })
        return existing
      }
    }
    throw error
  }
  if (input.is_default) await clearDefaultAddress(input.contact_id, data.id)
  return data
}

export async function updateAddress(id: string, contactId: string, input: Partial<AddressInput>): Promise<ClientDeliveryAddress> {
  const { data, error } = await supabase.from('contact_addresses').update(input).eq('id', id).select().single()
  if (error) throw error
  if (input.is_default) await clearDefaultAddress(contactId, id)
  return data
}

export async function deleteAddress(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('contact_addresses').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

/** Only one default address per contact -- unsets any previous one before a
 * new insert/update claims it, since there's no partial-unique-index doing
 * this at the DB layer (kept simple, same level of enforcement as the rest
 * of this CRM). */
async function clearDefaultAddress(contactId: string, exceptId: string): Promise<void> {
  const { error } = await supabase.from('contact_addresses').update({ is_default: false }).eq('contact_id', contactId).eq('is_default', true).neq('id', exceptId)
  if (error) throw error
}
