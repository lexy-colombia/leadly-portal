import { supabase } from '../supabaseClient'
import type { PermissionAction, TenantRole } from '../../types/domain'

/** Catálogo fijo de acciones posibles -- ver permission_actions. De código,
 * nadie lo edita desde la UI (agregar una acción nueva es una migración). */
export async function listPermissionActions(): Promise<PermissionAction[]> {
  const { data, error } = await supabase.from('permission_actions').select('*').order('module_key').order('display_order')
  if (error) throw error
  return data
}

export async function listTenantRoles(tenantId: string): Promise<TenantRole[]> {
  const { data, error } = await supabase
    .from('tenant_roles')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .order('created_at')
  if (error) throw error
  return data
}

export async function createTenantRole(tenantId: string, name: string, description: string | null): Promise<TenantRole> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('tenant_roles')
    .insert({ tenant_id: tenantId, name, description, created_by: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateTenantRole(id: string, name: string, description: string | null): Promise<TenantRole> {
  const { data, error } = await supabase.from('tenant_roles').update({ name, description }).eq('id', id).select().single()
  if (error) throw error
  return data
}

/** Soft delete (ver CLAUDE.md sección 3) -- tiene identidad de negocio real
 * (usuarios quedan asignados a esta fila). Un rol con agentes asignados no
 * debería borrarse sin reasignarlos primero -- el caller ya lo valida. */
export async function deleteTenantRole(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('tenant_roles').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

export async function listRolePermissionKeys(roleId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('tenant_role_permissions').select('action_key').eq('tenant_role_id', roleId)
  if (error) throw error
  return new Set(data.map((row) => row.action_key))
}

/** Reemplaza el set completo de acciones de un rol por `actionKeys` -- diff
 * simple contra lo que ya está guardado (insertar lo nuevo, borrar lo que se
 * destildó) en vez de un delete-all + insert-all, para no generar una
 * ventana sin permisos a mitad de guardado. */
export async function setRolePermissions(roleId: string, actionKeys: string[]): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const current = await listRolePermissionKeys(roleId)
  const next = new Set(actionKeys)

  const toAdd = actionKeys.filter((key) => !current.has(key))
  const toRemove = [...current].filter((key) => !next.has(key))

  if (toAdd.length > 0) {
    const { error } = await supabase
      .from('tenant_role_permissions')
      .insert(toAdd.map((action_key) => ({ tenant_role_id: roleId, action_key, granted_by: user?.id ?? null })))
    if (error) throw error
  }
  if (toRemove.length > 0) {
    const { error } = await supabase.from('tenant_role_permissions').delete().eq('tenant_role_id', roleId).in('action_key', toRemove)
    if (error) throw error
  }
}

/** Permisos efectivos del usuario actual -- superadmin/tenant_admin tienen
 * todo implícito (mismo criterio que has_permission() en la base), así que
 * se resuelven localmente contra el catálogo sin ir a tenant_role_permissions.
 * tenant_agent los lee de su tenant_role_id. */
export async function listMyPermissionKeys(role: string, tenantRoleId: string | null): Promise<Set<string>> {
  if (role === 'superadmin' || role === 'tenant_admin') {
    const actions = await listPermissionActions()
    return new Set(actions.map((a) => a.key))
  }
  if (!tenantRoleId) return new Set()
  return listRolePermissionKeys(tenantRoleId)
}
