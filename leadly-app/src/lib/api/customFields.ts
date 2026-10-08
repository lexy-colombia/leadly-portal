import { supabase } from '../supabaseClient'
import type { CustomFieldDefinition, CustomFieldEntityType, CustomFieldType } from '../../types/domain'

export interface CustomFieldDefinitionInput {
  name: string
  /** Inmutable una vez creada (lo impone un trigger de la base). */
  field_type: CustomFieldType
  options: string[] | null
  visible_to_ai: boolean
  display_order: number
  is_active: boolean
}

/** Definiciones vivas (no borradas) de un tenant para una entidad. Cualquier
 * usuario del tenant puede leerlas (RLS) -- hacen falta para pintar la ficha.
 * `activeOnly` deja fuera las desactivadas (formularios/listados); la
 * pantalla de administración las pide todas. */
export async function listCustomFieldDefinitions(
  tenantId: string,
  entityType: CustomFieldEntityType = 'client',
  activeOnly = true,
): Promise<CustomFieldDefinition[]> {
  let request = supabase
    .from('custom_field_definitions')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('entity_type', entityType)
    .is('deleted_at', null)
  if (activeOnly) request = request.eq('is_active', true)
  const { data, error } = await request.order('display_order').order('created_at')
  if (error) throw error
  return data as CustomFieldDefinition[]
}

export async function createCustomFieldDefinition(
  tenantId: string,
  entityType: CustomFieldEntityType,
  input: CustomFieldDefinitionInput,
): Promise<CustomFieldDefinition> {
  const { data, error } = await supabase
    .from('custom_field_definitions')
    .insert({ tenant_id: tenantId, entity_type: entityType, ...input })
    .select()
    .single()
  if (error) throw error
  return data as CustomFieldDefinition
}

/** `field_type` no se envía al editar: el trigger de la base lo rechaza. */
export async function updateCustomFieldDefinition(
  id: string,
  input: Omit<CustomFieldDefinitionInput, 'field_type'>,
): Promise<CustomFieldDefinition> {
  const { data, error } = await supabase.from('custom_field_definitions').update(input).eq('id', id).select().single()
  if (error) throw error
  return data as CustomFieldDefinition
}

/** Soft delete (CLAUDE.md sección 3): los valores ya guardados en
 * clients.custom_fields no se tocan, solo deja de existir la definición. */
export async function deleteCustomFieldDefinition(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase
    .from('custom_field_definitions')
    .update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null })
    .eq('id', id)
  if (error) throw error
}
