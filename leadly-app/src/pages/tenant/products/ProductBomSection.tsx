import { useEffect, useId, useRef, useState } from 'react'
import { addProductBomLine, deleteProductBomLine, listProductBom, searchActiveMaterials, updateProductBomLine, type ProductBomLineWithMaterial } from '../../../lib/api/materials'
import type { Material } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { usePermission } from '../../../contexts/AuthContext'
import { useToast } from '../../../contexts/ToastContext'
import { PageSpinner } from '@/components/atoms'
import { TrashIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SearchSelect } from '@/components/molecules/SearchSelect'
import { Label } from '@/components/ui/label'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'

function formatCurrency(value: number, language: 'es' | 'en'): string {
  return new Intl.NumberFormat(language === 'en' ? 'en-US' : 'es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 2 }).format(value)
}

/** Fila editable: cantidad por unidad vendida, en la unidad del insumo.
 * Guarda al salir del campo (blur) o con Enter, y solo si cambió. */
function BomRow({ line, canEdit, onChanged }: { line: ProductBomLineWithMaterial; canEdit: boolean; onChanged: () => void }) {
  const { t } = useLanguage()
  const toast = useToast()
  const [value, setValue] = useState(String(line.quantity))
  const [busy, setBusy] = useState(false)
  useEffect(() => setValue(String(line.quantity)), [line.quantity])

  async function commit() {
    const next = Number(value)
    if (!(next > 0) || !Number.isFinite(next)) {
      setValue(String(line.quantity))
      toast.error(t('products.bom.errors.quantityInvalid'))
      return
    }
    if (next === line.quantity) return
    setBusy(true)
    try {
      await updateProductBomLine(line.id, next)
      onChanged()
    } catch (err) {
      setValue(String(line.quantity))
      toast.error(err instanceof Error ? err.message : t('products.bom.errors.save'))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    try {
      await deleteProductBomLine(line.id)
      onChanged()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('products.bom.errors.delete'))
    } finally {
      setBusy(false)
    }
  }

  const unit = line.material ? t(`materials.unit.${line.material.unit}`) : ''
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-brand-800">{line.material?.name ?? t('products.bom.materialMissing')}</p>
        {line.material && !line.material.is_active && <p className="text-[11px] text-amber-700">{t('products.bom.materialInactive')}</p>}
      </div>
      <Input
        type="number"
        min="0"
        step="any"
        value={value}
        disabled={!canEdit || busy}
        aria-label={t('products.bom.quantityLabel', { name: line.material?.name ?? '' })}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.currentTarget.blur()
          }
        }}
        className="!h-7 w-24 !rounded-lg text-right !text-xs"
      />
      <span className="w-10 shrink-0 text-[11px] text-brand-400">{unit}</span>
      {canEdit && (
        <Button type="button" variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" disabled={busy} aria-label={t('common.actions.delete')} onClick={remove}>
          <TrashIcon width={12} height={12} />
        </Button>
      )}
    </div>
  )
}

/** "Ficha técnica" de un producto que se arma con insumos: qué insumos y
 * cuánto de cada uno consume UNA unidad vendida. El costo es informativo
 * (suma cantidad × costo del insumo); la disponibilidad y el descuento de
 * stock los resuelve el backend. Editar exige `products.manage_bom`. */
export function ProductBomSection({ tenantId, productId, onChanged }: { tenantId: string; productId: string; onChanged?: () => void }) {
  const { t, language } = useLanguage()
  const toast = useToast()
  const canEdit = usePermission('products.manage_bom')
  const [lines, setLines] = useState<ProductBomLineWithMaterial[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [results, setResults] = useState<Material[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Material | null>(null)
  const [quantity, setQuantity] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const quantityRef = useRef<HTMLInputElement>(null)
  const quantityId = useId()

  function load() {
    setError(null)
    listProductBom(productId)
      .then(setLines)
      .catch((err) => setError(err.message ?? t('products.bom.errors.load')))
  }

  useEffect(() => {
    setLines(null)
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId])

  // Búsqueda server-side de insumos (acotada), con debounce.
  useEffect(() => {
    if (!pickerOpen) return
    let active = true
    setSearching(true)
    const timer = setTimeout(() => {
      searchActiveMaterials(tenantId, search)
        .then((list) => {
          if (active) setResults(list)
        })
        .catch(() => {
          if (active) setResults([])
        })
        .finally(() => {
          if (active) setSearching(false)
        })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [pickerOpen, search, tenantId])

  const usedIds = new Set((lines ?? []).map((l) => l.material_id))
  // Costo calculado, solo informativo.
  const cost = (lines ?? []).reduce((sum, l) => sum + l.quantity * (l.material?.cost ?? 0), 0)

  async function handleAdd() {
    setAddError(null)
    const q = Number(quantity)
    if (!selected || !(q > 0) || !Number.isFinite(q)) {
      setAddError(t('products.bom.errors.quantityInvalid'))
      return
    }
    setAdding(true)
    try {
      await addProductBomLine({ tenant_id: tenantId, product_id: productId, material_id: selected.id, quantity: q })
      toast.success(t('products.bom.toast.added'))
      setSelected(null)
      setQuantity('')
      load()
      onChanged?.()
    } catch (err) {
      setAddError(err instanceof Error ? err.message : t('products.bom.errors.save'))
    } finally {
      setAdding(false)
    }
  }

  function handleChanged() {
    load()
    onChanged?.()
  }

  return (
    <div className="flex flex-col gap-3">

      {error && (
        <p className="flex items-center gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
          <button type="button" className="underline" onClick={load}>
            {t('common.actions.retry')}
          </button>
        </p>
      )}
      {!lines && !error && <PageSpinner />}

      {lines && lines.length === 0 && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">{t('products.bom.empty')}</p>}

      {lines && lines.length > 0 && (
        <div className="divide-y divide-brand-100 rounded-lg border border-brand-100">
          {lines.map((l) => (
            <BomRow key={l.id} line={l} canEdit={canEdit} onChanged={handleChanged} />
          ))}
          <div className="flex items-center justify-between bg-brand-50/60 px-3 py-2">
            <span className="text-xs font-semibold text-brand-800">{t('products.bom.cost')}</span>
            <span className="text-xs font-semibold text-brand-800">{formatCurrency(cost, language)}</span>
          </div>
        </div>
      )}

      {!canEdit && <p className="text-[11px] text-brand-400">{t('products.bom.noPermission')}</p>}

      {canEdit && lines && (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
          <div className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label>{t('products.bom.pickMaterial')}</Label>
              <SearchSelect
                open={pickerOpen}
                onOpenChange={setPickerOpen}
                query={search}
                onQueryChange={setSearch}
                options={results.filter((material) => !usedIds.has(material.id)).map((material) => ({ value: material.id, label: material.name, detail: material.unit === 'm2' ? 'm²' : material.unit }))}
                value={selected?.id ?? null}
                label={selected?.name}
                placeholder={t('products.bom.searchMaterial')}
                searchPlaceholder={t('products.bom.searchMaterial')}
                emptyLabel={t('products.bom.noMaterials')}
                loadingLabel={t('products.bom.searching')}
                loading={searching}
                disabled={adding}
                onSelect={(id) => {
                  const material = results.find((item) => item.id === id)
                  if (!material) return
                  setSelected(material)
                  setAddError(null)
                  requestAnimationFrame(() => quantityRef.current?.focus())
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={quantityId}>{t('products.bom.quantityPlaceholder')}</Label>
              <InputGroup>
                <InputGroupInput ref={quantityRef} id={quantityId} type="number" min="0" step="any" value={quantity} placeholder="0" disabled={adding} onChange={(event) => setQuantity(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (selected && !adding && Number(quantity) > 0) void handleAdd() } }} className="text-right" />
                {selected && <InputGroupAddon align="inline-end">{selected.unit === 'm2' ? 'm²' : selected.unit}</InputGroupAddon>}
              </InputGroup>
            </div>
            <Button type="button" disabled={adding || !selected || !(Number(quantity) > 0) || !Number.isFinite(Number(quantity))} onClick={handleAdd}>{t('products.bom.add')}</Button>
          </div>
          {addError && <p className="text-xs text-red-700">{addError}</p>}
        </div>
      )}
    </div>
  )
}

