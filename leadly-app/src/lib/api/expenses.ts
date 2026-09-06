import { supabase } from '../supabaseClient'
import type { Expense, ExpenseInventoryEntry, ExpenseStatus } from '../../types/domain'

export interface ExpenseInput {
  tenant_id: string
  supplier_id?: string | null
  category_id?: string | null
  amount: number
  currency?: string
  description?: string | null
  payment_method?: string | null
  status?: ExpenseStatus
  expense_date?: string
  due_date?: string | null
  payment_date?: string | null
}

export type ExpenseWithRelations = Expense & {
  supplier: { id: string; name: string } | null
  category: { id: string; name: string } | null
}

const EXPENSE_SELECT = '*, supplier:suppliers(id, name), category:expense_categories(id, name)'

export interface ExpensesSummary {
  count: number
  total: number
  currency: string
}

export interface ListExpensesPageParams {
  page: number
  pageSize: number
  supplierId?: string | null
  categoryId?: string | null
  /** YYYY-MM-DD, ambos inclusive -- resueltos server-side. */
  dateFrom?: string | null
  dateTo?: string | null
}

export interface ListExpensesPageResult {
  data: ExpenseWithRelations[]
  count: number
  totalPages: number
  summary: ExpensesSummary
}

/** Pantalla "Gastos" (ExpensesTab.tsx) -- reemplaza el viejo
 * listExpenses(tenantId, filters) sin límite, que traía TODO el historial
 * filtrado a la vez (el tenant real ya tiene 6072 gastos migrados de Fudo,
 * por encima del corte de 1000 filas de PostgREST -- el resto quedaba
 * invisible sin ningún error). Paginación real con offset en la DB (Edge
 * Function list-expenses, que usa .range()) en vez de traer todo y cortar
 * en el navegador -- el resumen (cantidad + total en dinero) también se
 * calcula server-side ahí mismo, mismo criterio que listOrdersPage. */
export async function listExpensesPage(params: ListExpensesPageParams): Promise<ListExpensesPageResult> {
  const { data, error } = await supabase.functions.invoke<{
    data: ExpenseWithRelations[]
    count: number
    total_pages: number
    summary: ExpensesSummary
    error?: string
  }>('list-expenses', {
    body: {
      page: params.page,
      page_size: params.pageSize,
      supplier_id: params.supplierId ?? null,
      category_id: params.categoryId ?? null,
      date_from: params.dateFrom ?? null,
      date_to: params.dateTo ?? null,
    },
  })
  if (error) {
    const context = (error as { context?: Response }).context
    if (context && typeof context.json === 'function') {
      let specificMessage: string | undefined
      try {
        const responseBody = await context.json()
        specificMessage = responseBody?.error
      } catch {
        /* fall through to generic error */
      }
      if (specificMessage) throw new Error(specificMessage)
    }
    throw error
  }
  if (!data || data.error) throw new Error(data?.error ?? 'No se pudieron cargar los gastos.')
  return { data: data.data, count: data.count, totalPages: data.total_pages, summary: data.summary }
}

export async function getExpense(id: string): Promise<ExpenseWithRelations> {
  const { data, error } = await supabase.from('expenses').select(EXPENSE_SELECT).eq('id', id).single()
  if (error) throw error
  return data as unknown as ExpenseWithRelations
}

export async function createExpense(input: ExpenseInput): Promise<Expense> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { data, error } = await supabase
    .from('expenses')
    .insert({ ...input, created_by: user?.id ?? null })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function updateExpense(id: string, input: Partial<ExpenseInput>): Promise<Expense> {
  const { data, error } = await supabase.from('expenses').update(input).eq('id', id).select().single()
  if (error) throw error
  return data
}

export async function deleteExpense(id: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser()
  const { error } = await supabase.from('expenses').update({ deleted_at: new Date().toISOString(), deleted_by: user?.id ?? null }).eq('id', id)
  if (error) throw error
}

export type ExpenseInventoryEntryWithDetails = ExpenseInventoryEntry & {
  product: { id: string; name: string } | null
  variant: { id: string; option1_value: string | null; option2_value: string | null; option3_value: string | null } | null
  warehouse: { id: string; name: string } | null
}

export async function listExpenseInventoryEntries(expenseId: string): Promise<ExpenseInventoryEntryWithDetails[]> {
  const { data, error } = await supabase
    .from('expense_inventory_entries')
    .select('*, product:products(id, name), variant:product_variants(id, option1_value, option2_value, option3_value), warehouse:warehouses(id, name)')
    .eq('expense_id', expenseId)
    .order('created_at', { ascending: true })
  if (error) throw error
  return data as unknown as ExpenseInventoryEntryWithDetails[]
}

export interface AddExpenseInventoryEntryInput {
  tenant_id: string
  expense_id: string
  product_id: string
  warehouse_id: string
  quantity: number
  unit_cost: number
  variant_id?: string | null
  notes?: string | null
}

/** Wraps the `add_expense_inventory_entry` DB function -- validates the
 * running total against the expense's amount, inserts the entry, records
 * the resulting stock_movements row (reference_type='compra') and
 * overwrites purchase_price on the product/variant, all in one transaction.
 * See 20260906035734_expense_inventory_entries.sql. */
export async function addExpenseInventoryEntry(input: AddExpenseInventoryEntryInput): Promise<string> {
  const { data, error } = await supabase.rpc('add_expense_inventory_entry', {
    p_tenant_id: input.tenant_id,
    p_expense_id: input.expense_id,
    p_product_id: input.product_id,
    p_warehouse_id: input.warehouse_id,
    p_quantity: input.quantity,
    p_unit_cost: input.unit_cost,
    p_variant_id: input.variant_id ?? null,
    p_notes: input.notes ?? null,
  })
  if (error) throw error
  return data as string
}
