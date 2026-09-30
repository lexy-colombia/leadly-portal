import { supabase } from '../supabaseClient'

/** Cliente del módulo "Reportes" (balance financiero + reportes de
 * producto) -- envuelve la Edge Function `reports-summary`, mismo patrón
 * exacto que `listExpensesPage` en `lib/api/expenses.ts` (JWT del caller ->
 * la función resuelve tenant_id server-side -> RPC de agregación en
 * Postgres, nunca traemos filas crudas al navegador para sumarlas acá).
 *
 * Convención de rango de fechas -- CRÍTICA, documentada igual en el propio
 * `reports-summary/index.ts`: [dateFrom, dateTo), dateTo es el instante
 * EXCLUSIVO de cierre. El caller (Reports.tsx) es responsable de armar
 * dateTo como la medianoche del día SIGUIENTE al último día que quiere
 * incluir -- estas dos funciones no hacen ningún ajuste de fecha, solo
 * reenvían lo que reciben tal cual. */

export interface FinancialReport {
  income_total: number
  income_count: number
  by_method: Record<string, number>
  by_channel: Record<string, number>
  invoiced_total: number
  invoiced_count: number
  not_invoiced_total: number
  not_invoiced_count: number
  credit_notes_total: number
  returns_total: number
  expenses_paid_total: number
  expenses_paid_count: number
  expenses_pending_total: number
  expenses_pending_count: number
  expenses_by_category: Record<string, number>
  net_balance: number
  currency: string
}

export interface ProductSummaryRow {
  product_id: string | null
  product_name: string
  quantity: number
  revenue: number
}

export interface DailySeriesPoint {
  date: string
  quantity: number
  revenue: number
}

export interface CategoryOrBrandStat {
  quantity: number
  revenue: number
}

export interface StaleProductRow {
  product_id: string
  product_name: string
  last_sale_at: string | null
}

export interface GrossMarginRow {
  product_id: string | null
  product_name: string
  revenue: number
  /** null = costo del producto desconocido (purchase_price sin cargar) --
   * NUNCA tratar como 0, ver reports-summary/RPC. */
  estimated_cost: number | null
  estimated_margin: number | null
}

export interface ProductReport {
  top_by_quantity: ProductSummaryRow[]
  top_by_revenue: ProductSummaryRow[]
  daily_series: DailySeriesPoint[]
  by_category: Record<string, CategoryOrBrandStat>
  by_brand: Record<string, CategoryOrBrandStat>
  stale_products: StaleProductRow[]
  gross_margin: GrossMarginRow[]
}

/** Mismo manejo de error que el resto de las Edge Functions invocadas vía
 * `supabase.functions.invoke` (ver `listExpensesPage`/`getExpensePdf` en
 * expenses.ts): si la función respondió con un body JSON de error, se usa
 * ese mensaje específico; si no, se relanza el error crudo del SDK. */
async function extractInvokeError(error: unknown, fallback: string): Promise<Error> {
  const context = (error as { context?: Response }).context
  if (context && typeof context.json === 'function') {
    try {
      const responseBody = await context.json()
      if (responseBody?.error) return new Error(responseBody.error)
    } catch {
      /* fall through to generic error */
    }
  }
  return error instanceof Error ? error : new Error(fallback)
}

export async function getFinancialReport(dateFrom: string, dateTo: string): Promise<FinancialReport> {
  const { data, error } = await supabase.functions.invoke<{ data: FinancialReport; error?: string }>('reports-summary', {
    body: { report: 'financial', date_from: dateFrom, date_to: dateTo },
  })
  if (error) throw await extractInvokeError(error, 'No se pudo cargar el balance financiero.')
  if (!data || data.error) throw new Error(data?.error ?? 'No se pudo cargar el balance financiero.')
  return data.data
}

export async function getProductReport(dateFrom: string, dateTo: string, opts?: { limit?: number; staleDays?: number }): Promise<ProductReport> {
  const { data, error } = await supabase.functions.invoke<{ data: ProductReport; error?: string }>('reports-summary', {
    body: {
      report: 'products',
      date_from: dateFrom,
      date_to: dateTo,
      limit: opts?.limit,
      stale_days: opts?.staleDays,
    },
  })
  if (error) throw await extractInvokeError(error, 'No se pudo cargar el reporte de productos.')
  if (!data || data.error) throw new Error(data?.error ?? 'No se pudo cargar el reporte de productos.')
  return data.data
}
