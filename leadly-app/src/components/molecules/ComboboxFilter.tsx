import { useState } from 'react'
import { ChevronDownIcon, XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

export interface ComboboxOption {
  id: string
  label: string
  color?: string | null
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
   * length and looking mismatched next to the others. */
  triggerClassName?: string
}) {
  const [open, setOpen] = useState(false)
  const selected = value ? (options.find((o) => o.id === value) ?? null) : null

  return (
    <div className={`flex items-center gap-1 ${className}`}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className={cn('justify-between font-normal', triggerClassName)}>
            <span className="truncate">{selected ? selected.label : placeholder}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-0" align="start">
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
                    <span className="flex-1 truncate">{opt.label}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected && (
        <Button variant="ghost" size="icon-sm" onClick={() => onChange(null)} aria-label={placeholder}>
          <XIcon className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
