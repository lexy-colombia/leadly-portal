import { ChevronLeftIcon } from '../icons'

/** Simple prev/next pager -- used to cap every list in the app at a fixed
 * page size so a page's content stays short enough to fit the viewport
 * without scrolling at normal screen sizes (only very short viewports still
 * need to scroll). No numbered page list: at the scale these lists run at
 * (a single tenant's own contacts/PQR/etc.), "Página X de Y" is enough. */
export function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  if (totalPages <= 1) return null

  return (
    <div className="flex items-center justify-center gap-3 border-t border-brand-100 px-4 py-3">
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-500 transition-colors hover:bg-brand-50 hover:text-brand-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        <ChevronLeftIcon width={14} height={14} /> Anterior
      </button>
      <span className="text-xs text-brand-400">
        Página {page} de {totalPages}
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-brand-500 transition-colors hover:bg-brand-50 hover:text-brand-800 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
      >
        Siguiente <ChevronLeftIcon width={14} height={14} className="rotate-180" />
      </button>
    </div>
  )
}
