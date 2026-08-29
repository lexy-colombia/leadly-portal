import { supabase } from '../supabaseClient'
import type { Profile, UserRole } from '../../types/domain'

export interface InviteTenantUserInput {
  email: string
  full_name: string
  phone: string | null
  role: UserRole
  tenant_id: string | null
  /** Requerido cuando role='tenant_agent' -- a qué tenant_role queda
   * asignado (ver lib/api/permissions.ts). Ignorado para los demás roles. */
  tenant_role_id?: string | null
}

export async function listProfilesByTenant(tenantId: string): Promise<Profile[]> {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

/** Invites a user via the admin-create-tenant-user Edge Function -- creates
 * the auth.users row (emailing them a set-password link) and the matching
 * profiles row in one server-side step. Never touches a password directly. */
export async function inviteTenantUser(input: InviteTenantUserInput): Promise<Profile> {
  const { data, error } = await supabase.functions.invoke('admin-create-tenant-user', { body: input })
  if (error) {
    // On a non-2xx response, supabase-js returns a generic FunctionsHttpError
    // ("Edge Function returned a non-2xx status code") in `error.message` and
    // leaves `data` null -- the actual {error: "..."} body our function sent
    // is only reachable via error.context, a Response object. Unwrap it so
    // the UI shows e.g. "tenant_admin callers can only..." instead of the
    // generic message.
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      let specificMessage: string | undefined
      try {
        const body = await context.json()
        specificMessage = body?.error
      } catch {
        // context wasn't valid JSON -- fall through to the generic error below.
      }
      if (specificMessage) throw new Error(specificMessage)
    }
    throw error
  }
  if (data?.error) throw new Error(data.error)
  return data.profile
}

export async function setProfileActive(id: string, active: boolean): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').update({ active }).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** "Mi cuenta" self-service edit -- RLS's profiles_update policy already
 * lets a user update their own row (id = auth.uid()), restricted to
 * full_name/phone here since role/tenant_id/active are privilege-bearing
 * columns a DB trigger blocks from self-service edits regardless. */
export async function updateOwnProfile(id: string, input: { full_name: string; phone: string | null }): Promise<Profile> {
  const { data, error } = await supabase.from('profiles').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function changeOwnPassword(newPassword: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ password: newPassword })
  if (error) throw error
}
