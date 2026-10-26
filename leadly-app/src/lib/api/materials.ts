import { supabase } from '../supabaseClient'
import type { Material, MaterialMovement, MaterialMovementType, MaterialReferenceType, MaterialUnit, ProductBomLine } from '../../types/domain'
import type { TranslationKey } from '../../i18n/translations'

/** Unidades válidas (CHECK de `materials.unit`). Una unidad por insumo, sin
 * conversión entre unidades (decisión cerrada del contrato A). */
export const MATERIAL_UNITS: MaterialUnit[] = ['un', 'kg', 'g', 'l', 'ml', 'm', 'cm', 'm2']

/** Cantidades decimales (hasta 4 decimales, igual que numeric(14,4)). Solo
 * formateo: nada se calcula acá. */
export function formatQuantity(value: number, language: 'es' | 'en' = 'es'): string {
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es-CO', { maximumFractionDigits: 4 }).format(value)
}

export const MATERIAL_MOVEMENT_TYPE_KEY: Record<MaterialMovementType, TranslationKey> = {
  entrada: 'materials.movementType.entrada',
  salida: 'materials.movementType.salida',
  ajuste_positivo: 'materials.movementType.ajuste_positivo',
  ajuste_negativo: 'materials.movementType.ajuste_negativo',
  carga_inicial: 'materials.movementType.carga_inicial',
}

const MATERIAL_ENTRY_TYPES: MaterialMovementType[] = ['entrada', 'ajuste_positivo', 'carga_inicial']

/** true si el movimiento suma a la cantidad del insumo (solo para elegir
 * signo/color en el kardex). */
export function isMaterialEntry(type: MaterialMovementType): boolean {
  return MATERIAL_ENTRY_TYPES.includes(type)
}

/** Fila de `get_materials_overview`: el insumo + sus totales calculados por
 * el backend (total físico, reservado por carritos abiertos y disponible).
 * `count` es el total de filas del filtro (para paginar). */
export type MaterialOverviewRow = Material & {
  total_quantity: number
  reserved: number
  available: number
  count?: number
}

export interface MaterialsPageResult {
  data: MaterialOverviewRow[]
  count: number
}

/** Listado paginado server-side (RPC `get_materials_overview`, tenant desde
 * la sesión). El conteo total sale de la propia respuesta; si la página
 * pedida quedó más allá del final (fila vacía) no hay conteo y se devuelve
 * 0 con la lista vacía -- el llamador vuelve a la página 1. */
export async function listMaterialsPage(params: { search: string; page: number; pageSize: number }): Promise<MaterialsPageResult> {
  const { data, error } = await supabase.rpc('get_materials_overview', {
    p_search: params.search || null,
    p_limit: params.pageSize,
    p_offset: (params.page - 1) * params.pageSize,
  })
  if (error) throw error
  const rows = ((data ?? []) as MaterialOverviewRow[]).map((r) => ({
    ...r,
    cost: Number(r.cost),
    min_stock: r.min_stock == null ? null : Number(r.min_stock),
    total_quantity: Number(r.total_quantity),
    reserved: Number(r.reserved),
    available: Number(r.available),
    count: r.count == null ? undefined : Number(r.count),
  }))
  return { data: rows, count: rows[0]?.count ?? 0 }
}

export interface MaterialInput {
  tenant_id: string
  name: string
  sku?: string | null
  unit: MaterialUnit
  cost?: number
  min_stock?: number | null
  is_active?: boolean
  notes?: string | null
}

export async function createMaterial(input: MaterialInput): Promise<Material> {
  const { data, error } = await supabase.from('materials').insert(input).select().single()
  if (error) throw error
  return data as Material
}

export async function updateMaterial(id: string, patch: Partial<MaterialInput>): Promise<Material> {
  const { data, error } = await supabase.from('materials').update(patch).eq('id', id).select().single()
  if (error) throw error
  return data as Material
}

/** Soft-delete (convención del proyecto). */
export async function deleteMaterial(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('materials').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

/** Búsqueda de insumos activos para el selector de la ficha técnica --
 * server-side y acotada (nunca el catálogo completo). */
export async function searchActiveMaterials(tenantId: string, search: string, limit = 20): Promise<Material[]> {
  let query = supabase.from('materials').select('*').eq('tenant_id', tenantId).eq('is_active', true).is('deleted_at', null).order('name').limit(limit)
  const term = search.trim().replace(/[,()%_]/g, '\\$&')
  if (term) query = query.or(`name.ilike.%${term}%,sku.ilike.%${term}%`)
  const { data, error } = await query
  if (error) throw error
  return data as Material[]
}

export type MaterialStockWithWarehouse = { warehouse_id: string; quantity: number; warehouse: { id: string; name: string } }

/** Cantidad FÍSICA por bodega de un insumo (solo para pantallas de ajuste;
 * la disponibilidad sale de `get_materials_overview`). */
export async function listMaterialStock(materialId: string): Promise<MaterialStockWithWarehouse[]> {
  const { data, error } = await supabase
    .from('material_stock')
    .select('warehouse_id, quantity, warehouse:warehouses(id, name)')
    .eq('material_id', materialId)
    .order('quantity', { ascending: false })
  if (error) throw error
  return (data as unknown as MaterialStockWithWarehouse[]).map((r) => ({ ...r, quantity: Number(r.quantity) }))
}

export type MaterialMovementWithWarehouse = MaterialMovement & {
  warehouse: { id: string; name: string } | null
  /** Quién lo registró (profiles legible por RLS dentro del mismo tenant);
   * null si fue un proceso del servidor (venta) o el usuario ya no existe. */
  creator?: { id: string; full_name: string } | null
}

export interface MaterialMovementFilters {
  type?: MaterialMovementType | null
  /** yyyy-mm-dd, inclusivo (día local del navegador). */
  from?: string | null
  to?: string | null
}

/** Kardex del insumo, paginado server-side, con filtros de tipo y rango de
 * fechas. */
export async function listMaterialMovementsPage(
  materialId: string,
  page: number,
  pageSize: number,
  filters: MaterialMovementFilters = {},
): Promise<{ data: MaterialMovementWithWarehouse[]; count: number }> {
  const from = (page - 1) * pageSize
  let query = supabase
    .from('material_movements')
    .select('*, warehouse:warehouses(id, name), creator:profiles(id, full_name)', { count: 'exact' })
    .eq('material_id', materialId)
  if (filters.type) query = query.eq('movement_type', filters.type)
  if (filters.from) query = query.gte('created_at', new Date(`${filters.from}T00:00:00`).toISOString())
  if (filters.to) {
    const end = new Date(`${filters.to}T00:00:00`)
    end.setDate(end.getDate() + 1)
    query = query.lt('created_at', end.toISOString())
  }
  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .range(from, from + pageSize - 1)
  if (error) throw error
  const rows = (data as unknown as MaterialMovementWithWarehouse[]).map((m) => ({ ...m, quantity: Number(m.quantity), unit_cost: m.unit_cost == null ? null : Number(m.unit_cost) }))
  return { data: rows, count: count ?? 0 }
}

export async function getMaterial(id: string): Promise<Material | null> {
  const { data, error } = await supabase.from('materials').select('*').eq('id', id).is('deleted_at', null).maybeSingle()
  if (error) throw error
  if (!data) return null
  const m = data as Material
  return { ...m, cost: Number(m.cost), min_stock: m.min_stock == null ? null : Number(m.min_stock) }
}

/** Totales (físico/reservado/disponible) de UN insumo. `get_materials_overview`
 * no filtra por id: se busca por nombre (acotado a 200) y se toma la fila con
 * ese id. Limitación: si más de 200 insumos contienen ese nombre como
 * subcadena no se encuentra y devuelve null (la pantalla lo trata como error,
 * nunca calcula en cliente). Lo correcto sería una RPC por id. */
export async function getMaterialOverview(material: Pick<Material, 'id' | 'name'>): Promise<MaterialOverviewRow | null> {
  const { data } = await listMaterialsPage({ search: material.name, page: 1, pageSize: 200 })
  return data.find((r) => r.id === material.id) ?? null
}

export type MaterialUsageLine = {
  id: string
  quantity: number
  product: { id: string; name: string; sku: string | null; is_active: boolean } | null
}

/** Productos cuya ficha técnica usa el insumo, paginado server-side. */
export async function listMaterialUsagePage(materialId: string, page: number, pageSize: number): Promise<{ data: MaterialUsageLine[]; count: number }> {
  const from = (page - 1) * pageSize
  const { data, error, count } = await supabase
    .from('product_bom')
    .select('id, quantity, product:products!inner(id, name, sku, is_active, deleted_at)', { count: 'exact' })
    .eq('material_id', materialId)
    .is('product.deleted_at', null)
    .order('created_at', { ascending: true })
    .range(from, from + pageSize - 1)
  if (error) throw error
  return {
    data: (data as unknown as MaterialUsageLine[]).map((l) => ({ ...l, quantity: Number(l.quantity) })),
    count: count ?? 0,
  }
}

export interface MaterialMovementInput {
  tenant_id: string
  material_id: string
  warehouse_id: string
  movement_type: MaterialMovementType
  quantity: number
  unit_cost?: number | null
  notes?: string | null
}

/** Ajuste / carga inicial manual. Ledger append-only: un error se corrige
 * con otro movimiento, no editando. */
export async function recordMaterialMovement(input: MaterialMovementInput): Promise<MaterialMovement> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const reference_type: MaterialReferenceType = input.movement_type === 'carga_inicial' ? 'carga_inicial' : 'ajuste_manual'
  const { data, error } = await supabase
    .from('material_movements')
    .insert({ ...input, reference_type, created_by: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data as MaterialMovement
}

// --- Ficha técnica (product_bom) ---

export type ProductBomLineWithMaterial = ProductBomLine & {
  material: Pick<Material, 'id' | 'name' | 'unit' | 'cost' | 'is_active'> | null
}

export async function listProductBom(productId: string): Promise<ProductBomLineWithMaterial[]> {
  const { data, error } = await supabase
    .from('product_bom')
    .select('*, material:materials(id, name, unit, cost, is_active)')
    .eq('product_id', productId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return (data as unknown as ProductBomLineWithMaterial[]).map((l) => ({
    ...l,
    quantity: Number(l.quantity),
    material: l.material ? { ...l.material, cost: Number(l.material.cost) } : null,
  }))
}

export async function addProductBomLine(input: { tenant_id: string; product_id: string; material_id: string; quantity: number }): Promise<ProductBomLine> {
  const { data, error } = await supabase.from('product_bom').insert(input).select().single()
  if (error) throw error
  return data as ProductBomLine
}

export async function updateProductBomLine(id: string, quantity: number): Promise<void> {
  const { error } = await supabase.from('product_bom').update({ quantity }).eq('id', id)
  if (error) throw error
}

/** Borrado real (la ficha no es un registro de negocio con historial). */
export async function deleteProductBomLine(id: string): Promise<void> {
  const { error } = await supabase.from('product_bom').delete().eq('id', id)
  if (error) throw error
}

/** ¿El insumo ya tiene movimientos o aparece en alguna ficha técnica? (dos
 * conteos baratos, sin traer filas). Se usa para bloquear el cambio de su
 * unidad: las cantidades guardadas no se convierten. */
export async function materialHasHistory(materialId: string): Promise<boolean> {
  const [moves, boms] = await Promise.all([
    supabase.from('material_movements').select('id', { count: 'exact', head: true }).eq('material_id', materialId),
    supabase.from('product_bom').select('id', { count: 'exact', head: true }).eq('material_id', materialId),
  ])
  if (moves.error) throw moves.error
  if (boms.error) throw boms.error
  return (moves.count ?? 0) > 0 || (boms.count ?? 0) > 0
}
