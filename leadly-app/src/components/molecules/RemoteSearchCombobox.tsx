import { useEffect, useRef, useState } from 'react'
import { ChevronDownIcon, XIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** Selector de un elemento con búsqueda EN EL SERVIDOR (debounced): para
 * listas que pueden superar el tope de 1000 filas de PostgREST, donde no se
 * puede cargar todo y filtrar en memoria. Sin texto pide los resultados por
 * defecto de `search('')`. `resolve` trae la etiqueta del elemento cuando el
 * valor llega de fuera (edición). */
export function RemoteSearchCombobox<T>({
  value,
  onChange,
  search,
  resolve,
  getId,
  getLabel,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  className = '',
  triggerClassName = '',
  disabled = false,
}: {
  value: string | null
  onChange: (item: T | null) => void
  search: (query: string) => Promise<T[]>
  resolve?: (id: string) => Promise<T | null>
  getId: (item: T) => string
  getLabel: (item: T) => string
  placeholder: string
  searchPlaceholder: string
  emptyLabel: string
  className?: string
  triggerClassName?: string
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<T[]>([])
  const [selected, setSelected] = useState<T | null>(null)
  const [searching, setSearching] = useState(false)
  const requestId = useRef(0)
  // search/resolve suelen ser lambdas nuevas en cada render: se leen por ref
  // para no reiniciar los efectos.
  const searchRef = useRef(search)
  const resolveRef = useRef(resolve)
  searchRef.current = search
  resolveRef.current = resolve
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!value) {
      setSelected(null)
      return
    }
    if (selected && getId(selected) === value) return
    let cancelled = false
    resolveRef.current?.(value)
      .then((item) => {
        if (cancelled) return
        setSelected(item)
        // El valor apunta a algo que ya no existe (p. ej. cliente borrado):
        // se limpia para que el filtro no quede activo mostrando el placeholder.
        if (!item) onChangeRef.current(null)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  useEffect(() => {
    if (!open) return
    const id = ++requestId.current
    setSearching(true)
    const timer = setTimeout(
      () => {
        searchRef
          .current(query)
          .then((rows) => {
            if (requestId.current === id) setResults(rows)
          })
          .catch(() => {
            if (requestId.current === id) setResults([])
          })
          .finally(() => {
            if (requestId.current === id) setSearching(false)
          })
      },
      query ? 250 : 0,
    )
    return () => clearTimeout(timer)
  }, [open, query])

  return (
    <div className={`flex min-w-0 items-center gap-1 ${className}`}>
      <Popover open={open && !disabled} onOpenChange={(next) => setOpen(next && !disabled)}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled} className={cn('min-w-0 justify-between font-normal', triggerClassName)}>
            <span className="truncate">{selected ? getLabel(selected) : placeholder}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput value={query} onValueChange={setQuery} placeholder={searchPlaceholder} className="text-xs" />
            <CommandList>
              {!searching && <CommandEmpty className="text-xs">{emptyLabel}</CommandEmpty>}
              <CommandGroup>
                {results.map((item) => (
                  <CommandItem
                    key={getId(item)}
                    value={getId(item)}
                    onSelect={() => {
                      setSelected(item)
                      onChange(item)
                      setOpen(false)
                    }}
                    className="text-xs"
                  >
                    <span className="flex-1 truncate">{getLabel(item)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {selected && !disabled && (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            setSelected(null)
            onChange(null)
          }}
          aria-label={placeholder}
          className="shrink-0"
        >
          <XIcon className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
