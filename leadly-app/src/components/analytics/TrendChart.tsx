import { useId } from 'react'
import { useLanguage } from '@/contexts/LanguageContext'

export interface TrendPoint { label: string; value: number }

/** Responsive bars with a true zero baseline, scale, native keyboard tooltips and a data table. */
export function TrendChart({ points, formatValue, label }: { points: TrendPoint[]; formatValue: (value: number) => string; label: string }) {
  const id = useId()
  const { t } = useLanguage()
  if (points.length === 0 || points.every((p) => p.value === 0)) return <div className="flex min-h-52 items-center justify-center rounded-xl border border-dashed border-brand-100 bg-brand-50/30 p-6 text-center text-sm text-brand-400">{t('analytics.noActivity')}</div>
  const maximum = Math.max(1, ...points.map((p) => p.value))
  const step = Math.max(1, Math.ceil(points.length / 32))
  const buckets = Array.from({ length: Math.ceil(points.length / step) }, (_, i) => {
    const part = points.slice(i * step, (i + 1) * step)
    return { label: part.length === 1 ? part[0].label : `${part[0].label} – ${part[part.length - 1].label}`, value: part.reduce((sum, p) => sum + p.value, 0) }
  })
  const scale = step > 1 ? Math.max(1, ...buckets.map((p) => p.value)) : maximum
  const every = Math.max(1, Math.ceil(buckets.length / 4))
  return (
    <div>
      <div className="flex gap-3" role="group" aria-label={label}>
        <div aria-hidden="true" className="flex h-52 w-16 shrink-0 flex-col justify-between text-right text-[10px] tabular-nums text-brand-400">
          {[1, .75, .5, .25, 0].map((ratio) => <span key={ratio}>{formatValue(scale * ratio)}</span>)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="relative h-52">
            <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">{[0, 1, 2, 3, 4].map((n) => <div key={n} className="border-t border-dashed border-brand-100" />)}</div>
            <div className="relative flex h-full items-end gap-1 px-1">
              {buckets.map((p, i) => (
                <div key={i} className="group relative flex h-full min-w-0 flex-1 items-end">
                  <button type="button" aria-label={`${p.label}: ${formatValue(p.value)}`} aria-describedby={`${id}-${i}`} className="w-full rounded-t bg-accent-500 transition-colors hover:bg-accent-600 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-600" style={{ height: `${(p.value / scale) * 100}%`, minHeight: p.value > 0 ? 2 : 0 }} />
                  <span id={`${id}-${i}`} role="tooltip" className="pointer-events-none absolute bottom-full left-1/2 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg bg-brand-800 px-3 py-2 text-xs text-white shadow-lg group-hover:block group-focus-within:block">{p.label}<br /><strong>{formatValue(p.value)}</strong></span>
                </div>
              ))}
            </div>
          </div>
          <div aria-hidden="true" className="relative mt-3 h-5 text-[10px] text-brand-400">{buckets.map((p, i) => i % every === 0 ? <span key={i} className="absolute whitespace-nowrap" style={{ left: `${(i/(buckets.length||1))*100}%` }}>{p.label.split(' – ')[0].replace(/^(\d{2})-(\d{2})-\d{4}$/, '$1/$2')}</span> : null)}</div>
        </div>
      </div>
      <details className="mt-4 text-xs text-brand-400">
        <summary className="w-fit cursor-pointer rounded focus-visible:outline-2 focus-visible:outline-accent-600">{label}</summary>
        <div className="mt-2 max-h-48 overflow-auto"><table className="w-full"><tbody>{points.map((p, i) => <tr key={i} className="border-b border-brand-50"><th scope="row" className="py-1 text-left font-medium">{p.label}</th><td className="text-right tabular-nums">{formatValue(p.value)}</td></tr>)}</tbody></table></div>
      </details>
    </div>
  )
}
