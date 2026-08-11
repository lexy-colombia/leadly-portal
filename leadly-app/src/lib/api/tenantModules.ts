import { supabase } from '../supabaseClient'

/** Which module keys are currently enabled for a given tenant (presence-based,
 * same shape as ai_assistant_skills -- a row means enabled, no row means
 * disabled). See TENANT_MODULES in lib/modules.ts for the fixed catalog. */
export async function listEnabledModuleKeys(tenantId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('tenant_enabled_modules').select('module_key').eq('tenant_id', tenantId)
  if (error) throw error
  return new Set(data.map((row) => row.module_key))
}

/** Enabling/disabling is a superadmin-only action (RLS-enforced) -- the
 * bridge row has no business identity of its own, so this is a real
 * insert/delete, not a soft-delete (same exception as ai_assistant_skills). */
export async function setModuleEnabled(tenantId: string, moduleKey: string, enabled: boolean, enabledBy: string): Promise<void> {
  if (enabled) {
    const { error } = await supabase.from('tenant_enabled_modules').insert({ tenant_id: tenantId, module_key: moduleKey, enabled_by: enabledBy })
    if (error) throw error
  } else {
    const { error } = await supabase.from('tenant_enabled_modules').delete().eq('tenant_id', tenantId).eq('module_key', moduleKey)
    if (error) throw error
  }
}
