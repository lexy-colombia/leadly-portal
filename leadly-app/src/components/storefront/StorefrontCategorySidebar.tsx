import { useEffect, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon } from 'lucide-react'
import type { ProductCategory } from '@/types/domain'
import { descendantIds } from '@/lib/api/productCategories'

function childrenOf(categories: ProductCategory[], parentId: string | null): ProductCategory[] {
  return categories.filter((c) => c.parent_category_id === parentId).sort((a, b) => a.name.localeCompare(b.name))
}

function ancestorChain(categories: ProductCategory[], id: string): string[] {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const chain: string[] = []
  let current = byId.get(id)
  while (current) {
    chain.unshift(current.id)
    current = current.parent_category_id ? byId.get(current.parent_category_id) : undefined
  }
  return chain
}

/** Suma el conteo propio de la categoría con el de todo su subárbol -- así
 * un nodo padre siempre muestra el total real de lo que hay debajo, sin que
 * el backend tenga que calcular ese rollup (ver countProductsByCategory en
 * la Edge Function, que a propósito solo cuenta lo propio de cada una). */
function rolledUpCount(categories: ProductCategory[], counts: Record<string, number>, id: string): number {
  let total = counts[id] ?? 0
  for (const descendantId of descendantIds(categories, id)) total += counts[descendantId] ?? 0
  return total
}

/** Árbol de categorías siempre visible (a diferencia de CategoryTreeFilter,
 * que es un combobox emergente pensado para el catálogo interno del
 * tenant) -- expandible nodo por nodo, con el conteo de productos de cada
 * uno, para la barra lateral del catálogo público. Elegir cualquier nodo
 * aplica el filtro al instante (todo su subárbol, resuelto por el caller vía
 * descendantIds) -- no hace falta un botón "Aplicar" para algo tan central
 * a la navegación como la categoría. */
export function StorefrontCategorySidebar({
  categories,
  counts,
  selectedId,
  onSelect,
  title,
  allLabel,
}: {
  categories: ProductCategory[]
  counts: Record<string, number>
  selectedId: string | null
  onSelect: (id: string | null) => void
  title: string
  allLabel: string
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  // Cuando el filtro activo cambia desde afuera (ej. se llega con un link
  // directo, o se limpia desde un chip), abre la rama correspondiente para
  // que el nodo seleccionado quede visible en vez de escondido en una rama
  // colapsada.
  useEffect(() => {
    if (!selectedId) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const id of ancestorChain(categories, selectedId)) next.add(id)
      return next
    })
  }, [selectedId, categories])

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function renderNode(category: ProductCategory, depth: number) {
    const children = childrenOf(categories, category.id)
    const hasChildren = children.length > 0
    const isOpen = expanded.has(category.id)
    const isSelected = selectedId === category.id
    const count = rolledUpCount(categories, counts, category.id)

    return (
      <div key={category.id}>
        <div
          className={`flex items-center gap-1 rounded-md py-1.5 pr-2 text-xs ${isSelected ? 'bg-primary/10 font-medium text-primary' : 'text-foreground hover:bg-muted'}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          {hasChildren ? (
            <button type="button" onClick={() => toggle(category.id)} className="shrink-0 text-muted-foreground hover:text-foreground" aria-label={category.name}>
              {isOpen ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
            </button>
          ) : (
            <span className="inline-block size-3.5 shrink-0" />
          )}
          <button type="button" onClick={() => onSelect(category.id)} className="min-w-0 flex-1 truncate text-left">
            {category.name}
          </button>
          <span className="shrink-0 text-[11px] text-muted-foreground">({count})</span>
        </div>
        {hasChildren && isOpen && <div>{children.map((child) => renderNode(child, depth + 1))}</div>}
      </div>
    )
  }

  return (
    <div className="space-y-1">
      <p className="px-2 pb-1 text-sm font-bold text-foreground">{title}</p>
      {childrenOf(categories, null).map((category) => renderNode(category, 0))}
      {selectedId && (
        <button type="button" onClick={() => onSelect(null)} className="mt-2 px-2 text-xs font-medium text-primary hover:underline">
          {allLabel}
        </button>
      )}
    </div>
  )
}
