import type { ReactNode } from 'react'
import { ProductImage } from '@/components/atoms'

/** Fila de un resultado de búsqueda de productos -- antes vivía duplicada
 * (misma imagen/nombre/SKU, mismas clases) en PosFastCheckout.tsx y en
 * OrderItemsEditor.tsx, cada una con su propia copia que había que
 * mantener sincronizada a mano. Pedido explícito del usuario: un solo
 * componente. Solo sabe de layout -- de dónde sale la URL de la imagen (el
 * POS ya trae `image_url` resuelto, el editor de ítems de Órdenes tiene que
 * armarla desde `images[0].storage_path`) y qué mostrar a la derecha (el
 * POS suma precio/stock ahí mismo; el editor de ítems no, esos datos se ven
 * recién una vez que la línea ya está agregada) queda del lado de quien
 * llama, vía `right`. */
export function ProductSearchResultRow({
  imageUrl,
  name,
  sku,
  disabled = false,
  onClick,
  right,
}: {
  imageUrl: string | null
  name: string
  sku: string | null
  disabled?: boolean
  onClick: () => void
  right?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent-50 disabled:cursor-not-allowed disabled:opacity-40"
    >
      <ProductImage src={imageUrl} name={name} className="size-7 shrink-0 rounded-md" iconSize={13} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium text-brand-800">{name}</span>
        <span className="block truncate text-[11px] text-brand-400">{sku ? `SKU: ${sku}` : '—'}</span>
      </span>
      {right && <span className="shrink-0 text-right">{right}</span>}
    </button>
  )
}
