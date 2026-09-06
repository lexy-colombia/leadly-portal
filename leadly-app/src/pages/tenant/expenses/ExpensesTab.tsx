import { useEffect, useState } from 'react'
import { deleteExpense, listExpensesPage, type ExpensesSummary, type ExpenseWithRelations } from '../../../lib/api/expenses'
import { listExpenseCategories } from '../../../lib/api/expenseCategories'
import { listSuppliers } from '../../../lib/api/suppliers'
import type { ExpenseCategory, ExpenseStatus, Supplier } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { formatDate } from '../../../lib/dates'
import { PageSpinner } from '@/components/atoms'
import { Card, ComboboxFilter, EmptyState, FilterField, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { TranslationKey } from '../../../i18n/translations'
import { ExpenseDrawer } from './ExpenseDrawer'

const PAGE_SIZE = 10

// Mismo criterio visual que la barra de filtros de Orders.tsx/Products.tsx --
// pedido explícito del usuario: "el mismo filtrado de ordenes debe ir aqui".
const FILTER_TRIGGER_CLASS = 'w-40 rounded-lg border-brand-300 text-xs'

const STATUS_BADGE_CLASS: Record<ExpenseStatus, string> = {
  pendiente: 'border-transparent bg-amber-100 text-amber-700',
  pagado: 'border-transparent bg-emerald-100 text-emerald-700',
  anulado: 'border-transparent bg-slate-100 text-slate-500',
}
const STATUS_LABEL: Record<ExpenseStatus, TranslationKey> = {
  pendiente: 'expenses.list.status.pendiente',
  pagado: 'expenses.list.status.pagado',
  anulado: 'expenses.list.status.anulado',
}

interface ExpenseFilters {
  supplierId: string | null
  categoryId: string | null
  dateFrom: string
  dateTo: string
}

/** YYYY-MM-DD de hoy en hora local -- mismo helper que Orders.tsx (el valor
 * por defecto de "Desde"/"Hasta" es siempre el día actual, pedido explícito
 * del usuario). */
function todayIso(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function defaultExpenseFilters(): ExpenseFilters {
  return { supplierId: null, categoryId: null, dateFrom: todayIso(), dateTo: todayIso() }
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** Misma tarjeta compacta que usa el resumen de Orders.tsx (SummaryTile) --
 * solo etiqueta + valor, sin nada más. */
function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-brand-100 bg-white px-2.5 py-1.5">
      <p className="truncate text-[10px] text-brand-400">{label}</p>
      <p className="truncate text-xs font-bold text-brand-800">{value}</p>
    </div>
  )
}

export function ExpensesTab({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [expenses, setExpenses] = useState<ExpenseWithRelations[] | null>(null)
  const [totalPages, setTotalPages] = useState(1)
  const [summary, setSummary] = useState<ExpensesSummary | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [page, setPage] = useState(1)
  // Borrador editable aparte de lo aplicado -- no refiltra en cada click,
  // solo al tocar "Aplicar" (mismo criterio que Orders.tsx).
  const [draft, setDraft] = useState<ExpenseFilters>(defaultExpenseFilters)
  const [filters, setFilters] = useState<ExpenseFilters>(defaultExpenseFilters)
  const filtersDirty = JSON.stringify(draft) !== JSON.stringify(filters)
  const filtersActive = JSON.stringify(filters) !== JSON.stringify(defaultExpenseFilters())
  const [drawer, setDrawer] = useState<{ open: boolean; expense: ExpenseWithRelations | null }>({ open: false, expense: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Paginación real server-side (Edge Function list-expenses, .range() en la
  // DB) -- reemplaza el viejo listExpenses(tenantId) sin límite, que traía
  // TODO el historial filtrado (el tenant real ya tiene 6072 gastos
  // migrados de Fudo, por encima del corte de 1000 filas de PostgREST). El
  // resumen (cantidad + total en dinero) viene calculado server-side en la
  // misma respuesta, por la misma razón.
  function reload() {
    setLoading(true)
    setError(null)
    listExpensesPage({
      page,
      pageSize: PAGE_SIZE,
      supplierId: filters.supplierId,
      categoryId: filters.categoryId,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
    })
      .then(({ data, totalPages: pages, summary: nextSummary }) => {
        setExpenses(data)
        setTotalPages(pages)
        setSummary(nextSummary)
      })
      .catch((err) => setError(err.message ?? t('expenses.list.errors.load')))
      .finally(() => setLoading(false))
  }

  useEffect(reload, [tenantId, page, filters])

  useEffect(() => {
    setPage(1)
  }, [filters])

  useEffect(() => {
    listSuppliers(tenantId).then(setSuppliers).catch(() => setSuppliers([]))
    listExpenseCategories(tenantId).then(setCategories).catch(() => setCategories([]))
  }, [tenantId])

  const pageItems = expenses

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteExpense(id)
      reload()
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('expenses.list.errors.delete'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2 rounded-2xl border border-brand-100 bg-brand-50/40 p-3">
        <FilterField label={t('expenses.list.filters.labels.supplier')}>
          <ComboboxFilter
            options={suppliers.map((s) => ({ id: s.id, label: s.name }))}
            value={draft.supplierId}
            onChange={(id) => setDraft((d) => ({ ...d, supplierId: id }))}
            placeholder={t('expenses.list.filters.allSuppliers')}
            searchPlaceholder={t('expenses.list.filters.searchSupplier')}
            emptyLabel={t('expenses.list.filters.noResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        </FilterField>

        <FilterField label={t('expenses.list.filters.labels.category')}>
          <ComboboxFilter
            options={categories.map((c) => ({ id: c.id, label: c.name }))}
            value={draft.categoryId}
            onChange={(id) => setDraft((d) => ({ ...d, categoryId: id }))}
            placeholder={t('expenses.list.filters.allCategories')}
            searchPlaceholder={t('expenses.list.filters.searchCategory')}
            emptyLabel={t('expenses.list.filters.noResults')}
            triggerClassName={FILTER_TRIGGER_CLASS}
          />
        </FilterField>

        <FilterField label={t('expenses.list.filters.dateFrom')}>
          <Input
            type="date"
            value={draft.dateFrom}
            onChange={(e) => setDraft((d) => ({ ...d, dateFrom: e.target.value }))}
            aria-label={t('expenses.list.filters.dateFrom')}
            className="h-7 w-36 rounded-lg border-brand-300 text-xs"
          />
        </FilterField>
        <FilterField label={t('expenses.list.filters.dateTo')}>
          <Input
            type="date"
            value={draft.dateTo}
            onChange={(e) => setDraft((d) => ({ ...d, dateTo: e.target.value }))}
            aria-label={t('expenses.list.filters.dateTo')}
            className="h-7 w-36 rounded-lg border-brand-300 text-xs"
          />
        </FilterField>

        <div className="flex shrink-0 items-center gap-1.5 pb-0.5">
          <Button type="button" size="sm" disabled={!filtersDirty} onClick={() => setFilters(draft)}>
            {t('expenses.list.filters.apply')}
          </Button>
          {(filtersActive || filtersDirty) && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                const cleared = defaultExpenseFilters()
                setDraft(cleared)
                setFilters(cleared)
              }}
            >
              {t('expenses.list.filters.clear')}
            </Button>
          )}
        </div>

        <Button onClick={() => setDrawer({ open: true, expense: null })} size="sm" className="ml-auto self-center">
          <PlusIcon width={14} height={14} /> {t('expenses.list.actions.new')}
        </Button>
      </div>

      {summary && summary.count > 0 && (
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          <SummaryTile label={t('expenses.list.summary.count')} value={String(summary.count)} />
          <SummaryTile label={t('expenses.list.summary.total')} value={formatCurrency(summary.total, summary.currency)} />
        </div>
      )}

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}
      {loading && !expenses && <PageSpinner />}

      {expenses && expenses.length === 0 && (
        <Card>
          <EmptyState>{filtersActive ? t('expenses.list.empty.noMatch') : t('expenses.list.empty.none')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('expenses.list.table.date')}</TableHead>
                  <TableHead>{t('expenses.list.table.supplier')}</TableHead>
                  <TableHead>{t('expenses.list.table.category')}</TableHead>
                  <TableHead>{t('expenses.list.table.amount')}</TableHead>
                  <TableHead>{t('expenses.list.table.status')}</TableHead>
                  <TableHead className="text-right">{t('expenses.list.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((expense) => (
                  <TableRow key={expense.id} onClick={() => setDrawer({ open: true, expense })} className="cursor-pointer">
                    <TableCell className="text-xs text-brand-500">{formatDate(expense.expense_date)}</TableCell>
                    <TableCell className="text-xs font-medium text-brand-800">{expense.supplier?.name ?? '—'}</TableCell>
                    <TableCell className="text-xs text-brand-500">{expense.category?.name ?? '—'}</TableCell>
                    <TableCell className="text-xs text-brand-700">{formatCurrency(expense.amount, expense.currency)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={STATUS_BADGE_CLASS[expense.status]}>
                        {t(STATUS_LABEL[expense.status])}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {deletingId === expense.id ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Button variant="destructive" size="xs" onClick={() => handleDelete(expense.id)} disabled={deleting}>
                            {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                          </Button>
                          <Button variant="ghost" size="xs" onClick={() => setDeletingId(null)} disabled={deleting}>
                            {t('common.actions.cancel')}
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <Button variant="ghost" size="icon-xs" onClick={() => setDrawer({ open: true, expense })}>
                            <PencilIcon width={12} height={12} />
                          </Button>
                          <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" onClick={() => setDeletingId(expense.id)}>
                            <TrashIcon width={12} height={12} />
                          </Button>
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      <ExpenseDrawer open={drawer.open} onClose={() => setDrawer({ open: false, expense: null })} tenantId={tenantId} expense={drawer.expense} onSaved={reload} />
    </div>
  )
}
