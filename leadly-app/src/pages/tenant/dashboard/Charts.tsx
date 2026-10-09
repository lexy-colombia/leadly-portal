import { useId } from 'react'
import { useLanguage } from '../../../contexts/LanguageContext'

export function SalesAreaChart({
  points,
  format,
  detailFormat = format,
  label,
}: {
  points: { label: string; value: number }[]
  format: (value: number) => string
  detailFormat?: (value: number) => string
  label: string
}) {
  const id = useId()
  const { t } = useLanguage()
  const max = Math.max(1, ...points.map((point) => point.value))
  const width = 320,
    height = 150
  const coords = points.map(
    (point, i) =>
      `${38 + (i / Math.max(1, points.length - 1)) * (width - 46)},${height - 10 - (point.value / max) * (height - 25)}`,
  )
  const path = coords.join(' ')
  return (
    <div>
      <svg
        viewBox="0 0 320 170"
        className="h-52 w-full"
        role="img"
        aria-label={label}
      >
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#2FA9A5" stopOpacity=".25" />
            <stop offset="1" stopColor="#2FA9A5" stopOpacity=".02" />
          </linearGradient>
        </defs>
        {[1, 0.75, 0.5, 0.25, 0].map((ratio) => (
          <g key={ratio}>
            <line
              x1="38"
              x2="312"
              y1={140 - ratio * 125}
              y2={140 - ratio * 125}
              stroke="#E5EAF1"
              strokeDasharray="3 4"
            />
            <text x="0" y={144 - ratio * 125} fontSize="8" fill="#8496BD">
              {format(max * ratio)}
            </text>
          </g>
        ))}
        {points.length > 0 && (
          <>
            <polygon points={`38,140 ${path} 312,140`} fill={`url(#${id})`} />
            <polyline
              points={path}
              fill="none"
              stroke="#2FA9A5"
              strokeWidth="2.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {points.map((point, i) => (
              <circle
                key={point.label}
                cx={38 + (i / Math.max(1, points.length - 1)) * 274}
                cy={140 - (point.value / max) * 125}
                r="4"
                fill="#2FA9A5"
                className="opacity-0 hover:opacity-100"
              >
                <title>
                  {point.label}: {detailFormat(point.value)}
                </title>
              </circle>
            ))}
          </>
        )}
        {points
          .filter(
            (_, i) =>
              i === 0 ||
              i === points.length - 1 ||
              i === Math.floor(points.length / 2),
          )
          .map((point, i) => (
            <text
              key={point.label}
              x={[38, 175, 312][i]}
              y="162"
              textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
              fontSize="8"
              fill="#8496BD"
            >
              {point.label}
            </text>
          ))}
      </svg>
      <details className="mt-2 text-[11px] text-brand-400">
        <summary className="cursor-pointer">{t('analytics.dataTable')}</summary>
        <div className="mt-2 max-h-48 overflow-auto">
          <table className="w-full">
            <caption className="sr-only">{label}</caption>
            <tbody>
              {points.map((point) => (
                <tr key={point.label} className="border-b border-brand-50">
                  <th scope="row" className="py-1 text-left font-medium">
                    {point.label}
                  </th>
                  <td className="text-right">{detailFormat(point.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
export function HorizontalBars({
  rows,
  format,
}: {
  rows: { label: string; value: number; detail?: string }[]
  format: (value: number) => string
}) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <div className="space-y-5">
      {rows.map((row, i) => (
        <div key={`${row.label}-${i}`}>
          <div className="mb-2 flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 break-words font-medium text-brand-700">
              {row.label}
            </span>
            <span className="shrink-0 text-[11px] tabular-nums text-brand-400">
              {row.detail ?? format(row.value)}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-brand-50">
            <div
              className="h-full rounded-full bg-gradient-to-r from-accent-600 to-accent-300"
              style={{ width: `${(Math.max(0, row.value) / max) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}
export function ChannelsChart({
  rows,
  format,
}: {
  rows: { label: string; value: number }[]
  format: (value: number) => string
}) {
  const total = rows.reduce((sum, row) => sum + row.value, 0)
  const colors = ['#2FA9A5', '#101A35', '#97DED9', '#8496BD', '#C7D5E5']
  let cursor = 0
  const gradient = rows
    .map((row, i) => {
      const start = cursor
      cursor += (row.value / total) * 100
      return `${colors[i % colors.length]} ${start}% ${cursor}%`
    })
    .join(',')
  return (
    <div className="flex flex-wrap items-center justify-center gap-6">
      <div
        className="relative flex h-32 w-32 shrink-0 items-center justify-center rounded-full"
        style={{ background: `conic-gradient(${gradient})` }}
        aria-hidden="true"
      >
        <div className="flex h-[90px] w-[90px] flex-col items-center justify-center rounded-full bg-white">
          <strong className="font-sans text-xl font-extrabold text-brand-800">
            100%
          </strong>
        </div>
      </div>
      <ul className="min-w-0 flex-1 space-y-4">
        {rows.map((row, i) => (
          <li key={row.label} className="text-[11px]">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2">
                <i
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: colors[i % colors.length] }}
                />
                {row.label}
              </span>
              <strong className="font-medium text-brand-400">
                {Math.round((row.value / total) * 100)}%
              </strong>
            </div>
            <span className="mt-1 block pl-4 text-[10px] text-brand-300">
              {format(row.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
