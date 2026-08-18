import { supabase } from '../supabaseClient'
import type { ContactAddress } from '../../types/domain'

export interface AddressInput {
  tenant_id: string
  contact_id: string
  label?: string | null
  is_shipping?: boolean
  is_billing?: boolean
  recipient_name?: string | null
  phone?: string | null
  tax_id?: string | null
  line1: string
  line2?: string | null
  city?: string | null
  state_province?: string | null
  postal_code?: string | null
  country?: string | null
  notes?: string | null
  is_default?: boolean
}

export async function listAddressesForContact(contactId: string): Promise<ContactAddress[]> {
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

export async function createAddress(input: AddressInput): Promise<ContactAddress> {
  if (input.is_default) await clearDefaultAddress(input.contact_id)
  const { data, error } = await supabase.from('contact_addresses').insert(input).select().single()
  if (error) throw error
  return data
}

export async function updateAddress(id: string, contactId: string, input: Partial<AddressInput>): Promise<ContactAddress> {
  if (input.is_default) await clearDefaultAddress(contactId)
  const { data, error } = await supabase.from('contact_addresses').update(input).eq('id', id).select().single()
  if (error) throw error
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
async function clearDefaultAddress(contactId: string): Promise<void> {
  const { error } = await supabase.from('contact_addresses').update({ is_default: false }).eq('contact_id', contactId).eq('is_default', true)
  if (error) throw error
}
