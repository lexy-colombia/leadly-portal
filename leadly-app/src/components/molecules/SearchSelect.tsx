import { ChevronsUpDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** Controlled server-search picker composed from the design-system primitives. */
export function SearchSelect({ open, onOpenChange, query, onQueryChange, options, value, label, placeholder, searchPlaceholder, emptyLabel, loadingLabel, loading = false, disabled = false, onSelect }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  query: string
  onQueryChange: (query: string) => void
  options: { value: string; label: string; detail?: string }[]
  value: string | null
  label?: string
  placeholder: string
  searchPlaceholder: string
  emptyLabel: string
  loadingLabel: string
  loading?: boolean
  disabled?: boolean
  onSelect: (value: string) => void
}) {
  return <Popover open={open} onOpenChange={onOpenChange}>
    <PopoverTrigger asChild>
      <Button type="button" variant="outline" disabled={disabled} aria-label={placeholder} className="w-full min-w-0 justify-between">
        <Search data-icon="inline-start" />
        <span className="min-w-0 flex-1 truncate text-left">{label ?? placeholder}</span>
        <ChevronsUpDown data-icon="inline-end" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" sideOffset={6} collisionPadding={12} className="w-[var(--radix-popover-trigger-width)] max-w-[calc(100vw-24px)] p-0">
      <Command shouldFilter={false}>
        <CommandInput aria-label={searchPlaceholder} value={query} onValueChange={onQueryChange} placeholder={searchPlaceholder} />
        <CommandList className="max-h-60" aria-busy={loading}>
          {loading ? <div role="status" className="px-3 py-5 text-center text-xs text-muted-foreground">{loadingLabel}</div> : <>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => <CommandItem key={option.value} value={option.value} aria-selected={value === option.value} onSelect={() => { onSelect(option.value); onOpenChange(false) }}>
                <span className="min-w-0 flex-1 truncate" title={option.label}>{option.label}</span>
                {option.detail && <span className="ml-3 shrink-0 text-[11px] text-muted-foreground">{option.detail}</span>}
              </CommandItem>)}
            </CommandGroup>
          </>}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}
