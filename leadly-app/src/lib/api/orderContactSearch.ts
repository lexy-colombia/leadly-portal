import { supabase } from '../supabaseClient'
import type { Client } from '../../types/domain'

/** Búsqueda en servidor de clientes para el selector de OrderDetail (nombre,
 * documento o teléfono). Reemplaza cargar el listado completo del tenant al
 * abrir un pedido: solo se consulta cuando el agente teclea en el selector.
 * Sin término útil (menos de 2 caracteres tras sanear) devuelve lista vacía,
 * nunca "los más recientes". No busca por `phone_prefix`: con términos cortos
 * ('57', '+5') empataba con casi todos los clientes. */
export async function searchClientsForOrder(tenantId: string, query: string, limit = 8): Promise<Client[]> {
  // Se quitan los caracteres que rompen la sintaxis de .or() de PostgREST.
  const term = query.trim().replace(/[,()%*\\]/g, ' ').trim()
  if (term.length < 2) return []
  const request = supabase
    .from('clients')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('deleted_at', null)
    .or(`full_name.ilike.%${term}%,document_number.ilike.%${term}%,phone.ilike.%${term}%`)
  const { data, error } = await request.order('updated_at', { ascending: false }).limit(limit)
  if (error) throw error
  return data
}
