import type { ReactNode } from 'react'

/** Etiqueta pequeña sobre un control de filtro (ComboboxFilter, un Input de
 * fecha, un toggle) -- deja claro qué tipo de filtro es cada uno, mismo
 * patrón en toda la barra de filtros de un listado. Extraído de
 * `Orders.tsx` (donde nació) para reusarlo también en `Products.tsx` y
 * `Clients.tsx` sin duplicar el mismo wrapper tres veces. */
export function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] font-medium text-brand-400">{label}</span>
      {children}
    </div>
  )
}
