const PALETTE = [
  'bg-accent-100 text-accent-700',
  'bg-indigo-100 text-indigo-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-teal-100 text-teal-700',
  'bg-violet-100 text-violet-700',
  'bg-sky-100 text-sky-700',
]

function colorForName(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % PALETTE.length
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

function initialsFor(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

const SIZES = {
  xs: 'h-6 w-6 text-[10px]',
  sm: 'h-8 w-8 text-xs',
  md: 'h-10 w-10 text-sm',
  lg: 'h-12 w-12 text-base',
}

/** Deterministic color-by-name avatar -- gives every list row (Clientes, Líneas,
 * Usuarios, ...) a bit of visual identity instead of plain text-only rows.
 * Soft pastel background + matching ink instead of a solid-color circle --
 * reads calmer and more modern in a dense table. */
export function InitialsAvatar({ name, size = 'md' }: { name: string; size?: keyof typeof SIZES }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-full font-semibold ${colorForName(name)} ${SIZES[size]}`}>
      {initialsFor(name)}
    </span>
  )
}
