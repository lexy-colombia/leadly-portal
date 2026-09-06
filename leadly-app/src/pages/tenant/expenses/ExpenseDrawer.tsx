import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { addExpenseInventoryEntry, createExpense, listExpenseInventoryEntries, updateExpense, type ExpenseInventoryEntryWithDetails, type ExpenseWithRelations } from '../../../lib/api/expenses'
import { listExpenseCategories } from '../../../lib/api/expenseCategories'
import { listSuppliers } from '../../../lib/api/suppliers'
import { listWarehouses } from '../../../lib/api/warehouses'
import { listProducts, formatVariantLabel, type ProductWithImages } from '../../../lib/api/products'
import type { Expense, ExpenseCategory, ExpenseStatus, Supplier, Warehouse } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { FieldError } from '@/components/atoms'
import { ComboboxFilter, CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isNotBlank } from '../../../lib/validation'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
const COMBOBOX_TRIGGER_CLASS = 'flex-1 !rounded-lg'

const STATUSES: ExpenseStatus[] = ['pendiente', 'pagado', 'anulado']

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-2.5">
      <p className="text-[11px] font-semibold tracking-wide text-brand-400 uppercase">{title}</p>
      {children}
    </div>
  )
}

function formatCurrency(value: number, currency: string): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function toNumberOrNull(value: string): number | null {
  if (!isNotBlank(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Minimal snapshot of the persisted expense header, kept in local state so
 * the "Entradas de inventario" sub-section can unlock right after creating
 * the expense (first Save) without waiting for the parent list to reload
 * and hand a fresh `expense` prop back down. */
type SavedExpense = { id: string; amount: number; status: ExpenseStatus; currency: string }

export function ExpenseDrawer({
  open,
  onClose,
  tenantId,
  expense,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  expense?: ExpenseWithRelations | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [categories, setCategories] = useState<ExpenseCategory[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [status, setStatus] = useState<ExpenseStatus>('pendiente')
  const [expenseDate, setExpenseDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [paymentDate, setPaymentDate] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const [savedExpense, setSavedExpense] = useState<SavedExpense | null>(null)

  // Inventory sub-section -- only meaningful once the expense has an id.
  const [entries, setEntries] = useState<ExpenseInventoryEntryWithDetails[] | null>(null)
  const [products, setProducts] = useState<ProductWithImages[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [entryProductId, setEntryProductId] = useState('')
  const [entryVariantId, setEntryVariantId] = useState('')
  const [entryWarehouseId, setEntryWarehouseId] = useState('')
  const [entryQuantity, setEntryQuantity] = useState('')
  const [entryUnitCost, setEntryUnitCost] = useState('')
  const [entryTouched, setEntryTouched] = useState(false)
  const [addingEntry, setAddingEntry] = useState(false)
  const [entryError, setEntryError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setSupplierId(expense?.supplier_id ?? '')
    setCategoryId(expense?.category_id ?? '')
    setAmount(expense ? String(expense.amount) : '')
    setDescription(expense?.description ?? '')
    setPaymentMethod(expense?.payment_method ?? '')
    setStatus(expense?.status ?? 'pendiente')
    setExpenseDate(expense?.expense_date ?? new Date().toISOString().slice(0, 10))
    setDueDate(expense?.due_date ?? '')
    setPaymentDate(expense?.payment_date ?? '')
    setTouched(false)
    setFormError(null)
    setSavedExpense(expense ? { id: expense.id, amount: expense.amount, status: expense.status, currency: expense.currency } : null)
    setEntries(null)
    setEntryProductId('')
    setEntryVariantId('')
    setEntryWarehouseId('')
    setEntryQuantity('')
    setEntryUnitCost('')
    setEntryTouched(false)
    setEntryError(null)

    listSuppliers(tenantId).then(setSuppliers).catch(() => setSuppliers([]))
    listExpenseCategories(tenantId).then(setCategories).catch(() => setCategories([]))
  }, [open, expense, tenantId])

  function reloadEntries(expenseId: string) {
    listExpenseInventoryEntries(expenseId)
      .then(setEntries)
      .catch((err) => setFormError(err instanceof Error ? err.message : t('expenses.list.errors.load')))
  }

  useEffect(() => {
    if (!savedExpense) return
    reloadEntries(savedExpense.id)
    listProducts(tenantId, { page: 1, pageSize: 500 })
      .then((res) => setProducts(res.data))
      .catch(() => setProducts([]))
    listWarehouses(tenantId)
      .then((list) => {
        setWarehouses(list)
        setEntryWarehouseId((current) => current || list.find((w) => w.is_default)?.id || list[0]?.id || '')
      })
      .catch(() => setWarehouses([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedExpense?.id, tenantId])

  const amountNumber = toNumberOrNull(amount)
  const amountError = touched && !(amountNumber !== null && amountNumber > 0) ? t('expenses.list.errors.amountRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!(amountNumber !== null && amountNumber > 0)) return

    setSubmitting(true)
    try {
      const input = {
        tenant_id: tenantId,
        supplier_id: supplierId || null,
        category_id: categoryId || null,
        amount: amountNumber,
        description: description.trim() || null,
        payment_method: paymentMethod.trim() || null,
        status,
        expense_date: expenseDate || undefined,
        due_date: dueDate || null,
        payment_date: paymentDate || null,
      }
      let saved: Expense
      if (savedExpense) saved = await updateExpense(savedExpense.id, input)
      else saved = await createExpense(input)
      setSavedExpense({ id: saved.id, amount: saved.amount, status: saved.status, currency: saved.currency })
      onSaved()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('expenses.list.errors.save'))
    } finally {
      setSubmitting(false)
    }
  }

  const entriesTotal = entries ? entries.reduce((sum, e) => sum + e.subtotal, 0) : 0
  const remaining = savedExpense ? savedExpense.amount - entriesTotal : 0
  const selectedProduct = products.find((p) => p.id === entryProductId) ?? null
  const activeVariants = selectedProduct?.variants.filter((v) => v.is_active) ?? []

  const entryQuantityNumber = Number(entryQuantity)
  const entryUnitCostNumber = toNumberOrNull(entryUnitCost)
  const entryQuantityError = entryTouched && !(entryQuantityNumber > 0) ? t('expenses.list.entries.errors.quantityRequired') : undefined
  const entryCostError = entryTouched && !(entryUnitCostNumber !== null && entryUnitCostNumber >= 0) ? t('expenses.list.entries.errors.costRequired') : undefined
  const entryProductError = entryTouched && !entryProductId ? t('expenses.list.entries.errors.productRequired') : undefined
  const entryVariantError = entryTouched && !!selectedProduct?.has_variants && !entryVariantId ? t('expenses.list.entries.errors.variantRequired') : undefined
  const entryWarehouseError = entryTouched && !entryWarehouseId ? t('expenses.list.entries.errors.warehouseRequired') : undefined

  async function handleAddEntry(e: FormEvent) {
    e.preventDefault()
    setEntryTouched(true)
    setEntryError(null)
    if (!savedExpense) return
    if (!entryProductId || !entryWarehouseId) return
    if (!(entryQuantityNumber > 0)) return
    if (entryUnitCostNumber === null || entryUnitCostNumber < 0) return
    if (selectedProduct?.has_variants && !entryVariantId) return

    setAddingEntry(true)
    try {
      await addExpenseInventoryEntry({
        tenant_id: tenantId,
        expense_id: savedExpense.id,
        product_id: entryProductId,
        variant_id: selectedProduct?.has_variants ? entryVariantId : null,
        warehouse_id: entryWarehouseId,
        quantity: entryQuantityNumber,
        unit_cost: entryUnitCostNumber,
      })
      reloadEntries(savedExpense.id)
      setEntryProductId('')
      setEntryVariantId('')
      setEntryQuantity('')
      setEntryUnitCost('')
      setEntryTouched(false)
    } catch (err) {
      setEntryError(err instanceof Error ? err.message : t('expenses.list.entries.errors.save'))
    } finally {
      setAddingEntry(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={savedExpense ? t('expenses.list.drawer.editTitle') : t('expenses.list.drawer.newTitle')}
      description={t('expenses.list.drawer.description')}
      size="lg"
    >
      <div className="space-y-6">
        <form onSubmit={handleSubmit} noValidate className="space-y-4">
          <Section title={t('expenses.list.sections.details')}>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{t('expenses.list.fields.supplier')}</Label>
                <div className="mt-1">
                  <ComboboxFilter
                    options={suppliers.map((s) => ({ id: s.id, label: s.name }))}
                    value={supplierId || null}
                    onChange={(id) => setSupplierId(id ?? '')}
                    placeholder={t('expenses.list.fields.noSupplier')}
                    searchPlaceholder={t('expenses.list.fields.searchSupplier')}
                    emptyLabel={t('expenses.list.fields.noSupplierResults')}
                    className="w-full"
                    triggerClassName={COMBOBOX_TRIGGER_CLASS}
                  />
                </div>
              </div>
              <div>
                <Label>{t('expenses.list.fields.category')}</Label>
                <div className="mt-1">
                  <ComboboxFilter
                    options={categories.map((c) => ({ id: c.id, label: c.name }))}
                    value={categoryId || null}
                    onChange={(id) => setCategoryId(id ?? '')}
                    placeholder={t('expenses.list.fields.noCategory')}
                    searchPlaceholder={t('expenses.list.fields.searchCategory')}
                    emptyLabel={t('expenses.list.fields.noCategoryResults')}
                    className="w-full"
                    triggerClassName={COMBOBOX_TRIGGER_CLASS}
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="expense-amount">{t('expenses.list.fields.amount')}</Label>
                <CurrencyInput id="expense-amount" value={amount} aria-invalid={!!amountError} onChange={(e) => setAmount(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
                <FieldError message={amountError} />
              </div>
              <div>
                <Label htmlFor="expense-status">{t('expenses.list.fields.status')}</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as ExpenseStatus)}>
                  <SelectTrigger id="expense-status" className={`mt-1 w-full ${FIELD_CLASS}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s} className="text-xs">
                        {t(`expenses.list.status.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label htmlFor="expense-date">{t('expenses.list.fields.expenseDate')}</Label>
                <Input id="expense-date" type="date" value={expenseDate} onChange={(e) => setExpenseDate(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
              </div>
              <div>
                <Label htmlFor="expense-due-date">{t('expenses.list.fields.dueDate')}</Label>
                <Input id="expense-due-date" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
              </div>
              <div>
                <Label htmlFor="expense-payment-date">{t('expenses.list.fields.paymentDate')}</Label>
                <Input id="expense-payment-date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
              </div>
            </div>

            <div>
              <Label htmlFor="expense-payment-method">{t('expenses.list.fields.paymentMethod')}</Label>
              <Input
                id="expense-payment-method"
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value)}
                placeholder={t('expenses.list.fields.paymentMethodPlaceholder')}
                className={`mt-1 ${FIELD_CLASS}`}
              />
            </div>

            <div>
              <Label htmlFor="expense-description">{t('expenses.list.fields.description')}</Label>
              <Textarea id="expense-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={`mt-1 ${TEXTAREA_CLASS}`} />
            </div>
          </Section>

          {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{formError}</p>}

          <div className="flex gap-2 border-t border-brand-100 pt-4">
            <Button type="submit" disabled={submitting}>
              {submitting ? t('common.actions.saving') : t('common.actions.save')}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              {t(savedExpense ? 'common.actions.close' : 'common.actions.cancel')}
            </Button>
          </div>
        </form>

        {savedExpense && (
          <Section title={t('expenses.list.sections.inventory')}>
            <div className="flex items-center justify-between rounded-lg border border-brand-100 bg-brand-50/60 px-3 py-2 text-xs">
              <span className="text-brand-600">{t('expenses.list.entries.total')}</span>
              <span className="font-medium text-brand-800">
                {formatCurrency(entriesTotal, savedExpense.currency)} / {formatCurrency(savedExpense.amount, savedExpense.currency)}
              </span>
            </div>

            {entries && entries.length > 0 && (
              <div className="space-y-1.5">
                {entries.map((entry) => (
                  <div key={entry.id} className="flex items-center justify-between rounded-lg border border-brand-100 px-3 py-2 text-xs">
                    <div className="min-w-0">
                      <p className="truncate font-medium text-brand-800">
                        {entry.product?.name ?? '—'}
                        {entry.variant && (
                          <span className="text-brand-400"> · {formatVariantLabel(entry.variant, selectedProduct?.options ?? [])}</span>
                        )}
                      </p>
                      <p className="text-brand-400">
                        {entry.quantity} × {formatCurrency(entry.unit_cost, savedExpense.currency)} · {entry.warehouse?.name ?? '—'}
                      </p>
                    </div>
                    <span className="shrink-0 font-medium text-brand-700">{formatCurrency(entry.subtotal, savedExpense.currency)}</span>
                  </div>
                ))}
              </div>
            )}

            {savedExpense.status === 'anulado' ? (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t('expenses.list.entries.voidedNotice')}</p>
            ) : (
              <form onSubmit={handleAddEntry} noValidate className="space-y-3 rounded-xl border border-dashed border-brand-200 p-3">
                <div>
                  <Label>{t('expenses.list.entries.fields.product')}</Label>
                  <div className="mt-1">
                    <ComboboxFilter
                      options={products.map((p) => ({ id: p.id, label: p.name }))}
                      value={entryProductId || null}
                      onChange={(id) => {
                        setEntryProductId(id ?? '')
                        setEntryVariantId('')
                      }}
                      placeholder={t('expenses.list.entries.fields.productPlaceholder')}
                      searchPlaceholder={t('expenses.list.entries.fields.searchProduct')}
                      emptyLabel={t('expenses.list.entries.fields.noProductResults')}
                      className="w-full"
                      triggerClassName={COMBOBOX_TRIGGER_CLASS}
                    />
                  </div>
                  <FieldError message={entryProductError} />
                </div>

                {selectedProduct?.has_variants && (
                  <div>
                    <Label htmlFor="entry-variant">{t('expenses.list.entries.fields.variant')}</Label>
                    <Select value={entryVariantId} onValueChange={setEntryVariantId}>
                      <SelectTrigger id="entry-variant" aria-invalid={!!entryVariantError} className={`mt-1 w-full ${FIELD_CLASS}`}>
                        <SelectValue placeholder={t('expenses.list.entries.fields.variantPlaceholder')} />
                      </SelectTrigger>
                      <SelectContent>
                        {activeVariants.map((v) => (
                          <SelectItem key={v.id} value={v.id} className="text-xs">
                            {formatVariantLabel(v, selectedProduct.options)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FieldError message={entryVariantError} />
                  </div>
                )}

                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <Label htmlFor="entry-warehouse">{t('expenses.list.entries.fields.warehouse')}</Label>
                    <Select value={entryWarehouseId} onValueChange={setEntryWarehouseId}>
                      <SelectTrigger id="entry-warehouse" aria-invalid={!!entryWarehouseError} className={`mt-1 w-full ${FIELD_CLASS}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {warehouses.map((w) => (
                          <SelectItem key={w.id} value={w.id} className="text-xs">
                            {w.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="entry-quantity">{t('expenses.list.entries.fields.quantity')}</Label>
                    <Input
                      id="entry-quantity"
                      type="number"
                      min="0"
                      step="any"
                      value={entryQuantity}
                      aria-invalid={!!entryQuantityError}
                      onChange={(e) => setEntryQuantity(e.target.value)}
                      className={`mt-1 ${FIELD_CLASS}`}
                    />
                  </div>
                  <div>
                    <Label htmlFor="entry-cost">{t('expenses.list.entries.fields.unitCost')}</Label>
                    <CurrencyInput
                      id="entry-cost"
                      value={entryUnitCost}
                      aria-invalid={!!entryCostError}
                      onChange={(e) => setEntryUnitCost(e.target.value)}
                      className={`mt-1 ${FIELD_CLASS}`}
                    />
                  </div>
                </div>
                <FieldError message={entryQuantityError ?? entryCostError} />

                {entryError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{entryError}</p>}

                <Button type="submit" size="sm" variant="outline" disabled={addingEntry || remaining <= 0}>
                  {addingEntry ? t('common.actions.saving') : t('expenses.list.entries.actions.add')}
                </Button>
                {remaining <= 0 && entries && entries.length > 0 && (
                  <p className="text-xs text-brand-400">{t('expenses.list.entries.capReached')}</p>
                )}
              </form>
            )}
          </Section>
        )}
      </div>
    </Drawer>
  )
}
