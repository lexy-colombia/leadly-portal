import { ChevronLeftIcon, ChevronRightIcon, MoreHorizontalIcon } from 'lucide-react'
import { useLanguage } from '@/contexts/LanguageContext'
import { Button } from '@/components/ui/button'

/** [1, 'ellipsis', 5, 6, 7, 'ellipsis', 42] -- current page ± 1 neighbor,
 * always the first and last page, an ellipsis over any gap. Keeps the pager
 * from turning into a wall of number buttons once a list runs into dozens
 * of pages (e.g. a 100+ product catalog at 10/page). */
function paginationRange(page: number, totalPages: number): (number | 'ellipsis')[] {
  const delta = 1
  const left = Math.max(2, page - delta)
  const right = Math.min(totalPages - 1, page + delta)
  const range: (number | 'ellipsis')[] = [1]
  if (left > 2) range.push('ellipsis')
  for (let i = left; i <= right; i++) range.push(i)
  if (right < totalPages - 1) range.push('ellipsis')
  if (totalPages > 1) range.push(totalPages)
  return range
}

/** Numbered pager (shadcn Button, "outline" marks the active page) -- used
 * to cap every list in the app at a fixed page size so a page's content
 * stays short enough to fit the viewport without scrolling. Same
 * `page`/`totalPages`/`onChange` contract this had as a plain prev/next
 * pager, so no caller needed to change for the redesign. */
export function Pagination({ page, totalPages, onChange }: { page: number; totalPages: number; onChange: (page: number) => void }) {
  const { t } = useLanguage()
  if (totalPages <= 1) return null

  return (
    <nav aria-label="pagination" className="flex items-center justify-end gap-1 border-t border-brand-100 px-4 py-3">
      <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label={t('common.pagination.previous')}>
        <ChevronLeftIcon className="size-4" />
      </Button>

      {paginationRange(page, totalPages).map((item, i) =>
        item === 'ellipsis' ? (
          <span key={`e-${i}`} className="flex size-7 items-center justify-center text-brand-300">
            <MoreHorizontalIcon className="size-4" />
          </span>
        ) : (
          <Button
            key={item}
            type="button"
            variant={item === page ? 'default' : 'ghost'}
            size="icon-sm"
            onClick={() => onChange(item)}
            aria-current={item === page ? 'page' : undefined}
            className={item === page ? 'text-xs' : 'border-transparent text-xs'}
          >
            {item}
          </Button>
        ),
      )}

      <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(page + 1)} disabled={page >= totalPages} aria-label={t('common.pagination.next')}>
        <ChevronRightIcon className="size-4" />
      </Button>
    </nav>
  )
}
