import { useEffect, useState } from 'react'
import { ChevronDownIcon, ChevronRightIcon, XIcon } from 'lucide-react'
import type { ProductCategory } from '@/types/domain'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

function ancestorChain(categories: ProductCategory[], id: string): ProductCategory[] {
  const byId = new Map(categories.map((c) => [c.id, c]))
  const chain: ProductCategory[] = []
  let current = byId.get(id)
  while (current) {
    chain.unshift(current)
    current = current.parent_category_id ? byId.get(current.parent_category_id) : undefined
  }
  return chain
}

function childrenOf(categories: ProductCategory[], parentId: string | null): ProductCategory[] {
  return categories.filter((c) => c.parent_category_id === parentId).sort((a, b) => a.name.localeCompare(b.name))
}

/** Category filter that mirrors the tenant's actual parent/child tree
 * (product_categories.parent_category_id, up to 3 levels deep in practice)
 * instead of a flat alphabetical list: root categories show first, and
 * picking one drills into its children so the next click narrows further --
 * "primero categorías sin padre y luego, si selecciono una, las categorías
 * hijas de esa" (explicit ask). Picking any node applies it immediately as
 * the filter (its whole subtree, via descendantIds in the caller) rather
 * than requiring a leaf -- browsing "Audio" alone is a valid filter on its
 * own, drilling further is optional refinement, not a requirement. */
export function CategoryTreeFilter({
  categories,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  rootLabel,
  triggerClassName = '',
}: {
  categories: ProductCategory[]
  value: string | null
  onChange: (id: string | null) => void
  placeholder: string
  searchPlaceholder: string
  emptyLabel: string
  rootLabel: string
  /** See ComboboxFilter's triggerClassName -- same reasoning, lines this
   * trigger up with the other filter pills next to it. */
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const [browsePath, setBrowsePath] = useState<ProductCategory[]>([])

  // Re-seed the drill position from the current filter every time the
  // popover opens, so reopening it lands where the active filter actually
  // is in the tree instead of always restarting at the roots.
  useEffect(() => {
    if (open) setBrowsePath(value ? ancestorChain(categories, value) : [])
  }, [open, value, categories])

  const currentParent = browsePath[browsePath.length - 1] ?? null
  const options = childrenOf(categories, currentParent?.id ?? null)
  const selected = value ? (categories.find((c) => c.id === value) ?? null) : null
  const selectedLabel = selected ? ancestorChain(categories, selected.id).map((c) => c.name).join(' / ') : null

  function selectCategory(category: ProductCategory) {
    onChange(category.id)
    setBrowsePath([...browsePath, category])
  }

  function jumpTo(index: number) {
    setBrowsePath(index < 0 ? [] : browsePath.slice(0, index + 1))
  }

  function clear() {
    onChange(null)
    setBrowsePath([])
  }

  return (
    <div className="flex items-center gap-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className={cn('justify-between font-normal', triggerClassName)}>
            <span className="truncate">{selectedLabel ?? placeholder}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          <Command>
            {browsePath.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 border-b border-border px-2 py-1.5 text-xs text-muted-foreground">
                <button type="button" onClick={() => jumpTo(-1)} className="hover:text-foreground hover:underline">
                  {rootLabel}
                </button>
                {browsePath.map((c, i) => (
                  <span key={c.id} className="flex items-center gap-1">
                    <span>/</span>
                    <button type="button" onClick={() => jumpTo(i)} className="hover:text-foreground hover:underline">
                      {c.name}
                    </button>
                  </span>
                ))}
              </div>
            )}
            {/* Command's own defaults are text-sm -- explicitly matched down
                to text-xs everywhere here so the options don't render
                noticeably bigger than the trigger button's own label. */}
            <CommandInput placeholder={searchPlaceholder} className="text-xs" />
            <CommandList>
              <CommandEmpty className="text-xs">{emptyLabel}</CommandEmpty>
              <CommandGroup>
                {options.map((category) => {
                  const hasChildren = categories.some((c) => c.parent_category_id === category.id)
                  return (
                    <CommandItem key={category.id} value={category.name} onSelect={() => selectCategory(category)} className="text-xs">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: category.color ?? '#94A3B8' }} />
                      <span className="flex-1 truncate">{category.name}</span>
                      {hasChildren && <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected && (
        <Button variant="ghost" size="icon-sm" onClick={clear} aria-label={placeholder}>
          <XIcon className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
