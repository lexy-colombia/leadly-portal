import { useState } from 'react'
import { ChevronDownIcon, XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ProductImage } from '@/components/atoms'

export interface ComboboxOption {
  id: string
  label: string
  color?: string | null
  /** Thumbnail shown before the label (trigger + each row) -- resolved URL,
   * or `null`/omitted for the colored-initial fallback (see ProductImage).
   * Optional and independent from `color` -- an option only ever uses one
   * of the two, whichever the caller passes (e.g. products pass `image`,
   * priorities/tags pass `color`). */
  image?: string | null
}

/** Searchable single-select filter (shadcn Popover + Command, the standard
 * "combobox" pattern) with a clear button next to the trigger -- used for
 * flat reference lists like brands, where a plain dropdown would get long
 * and a real tree (see CategoryTreeFilter) isn't needed. */
export function ComboboxFilter({
  options,
  value,
  onChange,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  className = '',
  triggerClassName = '',
  disabled = false,
}: {
  options: ComboboxOption[]
  value: string | null
  onChange: (id: string | null) => void
  placeholder: string
  searchPlaceholder: string
  emptyLabel: string
  className?: string
  /** Overrides the trigger button's size/shape -- lets a page line it up
   * exactly with its other filter controls (e.g. CategoryTreeFilter, a
   * plain shadcn Select) instead of each one auto-sizing to its own label
   * length and looking mismatched next to the others. Pass `flex-1` (not
   * `w-full`) when this sits in a row next to another control (e.g. the
   * clear button) -- see the `min-w-0` note below for why. */
  triggerClassName?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const selected = value ? (options.find((o) => o.id === value) ?? null) : null

  return (
    // min-w-0 on both this wrapper and the trigger below -- a flex/grid item
    // defaults to `min-width: auto`, which ignores `w-full` on the trigger
    // once the clear "x" button is also present as a sibling: the trigger
    // still claims 100% of its own box on top of the x button's width,
    // overflowing into whatever sits next to this whole component. Without
    // this, that's exactly what happened (Contacto's clear button bled into
    // the Envío column on OrderDetail.tsx's 3-column row).
    <div className={`flex min-w-0 items-center gap-1 ${className}`}>
      <Popover open={open && !disabled} onOpenChange={(next) => setOpen(next && !disabled)}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled} className={cn('min-w-0 justify-between font-normal', triggerClassName)}>
            <span className="flex min-w-0 items-center gap-2">
              {selected && 'image' in selected && <ProductImage src={selected.image} name={selected.label} className="size-5 shrink-0 rounded" iconSize={11} />}
              <span className="truncate">{selected ? selected.label : placeholder}</span>
            </span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-0" align="start">
          {/* Command's own defaults are text-sm -- explicitly matched down to
              text-xs everywhere here so the options don't render noticeably
              bigger than the trigger button's own label. */}
          <Command>
            <CommandInput placeholder={searchPlaceholder} className="text-xs" />
            <CommandList>
              <CommandEmpty className="text-xs">{emptyLabel}</CommandEmpty>
              <CommandGroup>
                {options.map((opt) => (
                  <CommandItem
                    key={opt.id}
                    value={opt.label}
                    onSelect={() => {
                      onChange(opt.id)
                      setOpen(false)
                    }}
                    className="text-xs"
                  >
                    {opt.color && <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: opt.color }} />}
                    {'image' in opt && <ProductImage src={opt.image} name={opt.label} className="size-6 shrink-0 rounded" iconSize={13} />}
                    <span className="flex-1 truncate">{opt.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected && !disabled && (
        <Button variant="ghost" size="icon-sm" onClick={() => onChange(null)} aria-label={placeholder} className="shrink-0">
          <XIcon className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
