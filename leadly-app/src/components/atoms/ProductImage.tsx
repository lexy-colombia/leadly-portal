import { BoxIcon } from './icons'

const PALETTE = [
  { bg: 'bg-accent-100', text: 'text-accent-500' },
  { bg: 'bg-indigo-100', text: 'text-indigo-500' },
  { bg: 'bg-amber-100', text: 'text-amber-500' },
  { bg: 'bg-rose-100', text: 'text-rose-500' },
  { bg: 'bg-teal-100', text: 'text-teal-500' },
  { bg: 'bg-violet-100', text: 'text-violet-500' },
  { bg: 'bg-sky-100', text: 'text-sky-500' },
]

function colorForName(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) % PALETTE.length
  return PALETTE[Math.abs(hash) % PALETTE.length]
}

/** Product photo with a colored fallback when there's no image yet --
 * deterministic pastel-by-name (same trick as InitialsAvatar) so an
 * unphotographed catalog still reads as distinct products instead of a
 * wall of identical gray boxes. Caller owns sizing/border/radius on its
 * wrapper; this component just fills it (`h-full w-full`). */
export function ProductImage({
  src,
  name,
  alt = '',
  className = '',
  iconSize = 16,
  fit = 'cover',
}: {
  src: string | null | undefined
  name: string
  alt?: string
  className?: string
  iconSize?: number
  /** 'cover' (default) fills and crops -- right for square catalog
   * thumbnails. 'contain' letterboxes instead of cropping -- use it where
   * seeing the whole product matters more than filling the box, e.g. an
   * order line where a cropped edge could hide which variant it is. */
  fit?: 'cover' | 'contain'
}) {
  if (src) {
    return <img src={src} alt={alt} className={`${fit === 'contain' ? 'object-contain' : 'object-cover'} ${className}`} />
  }
  const { bg, text } = colorForName(name)
  return (
    <div className={`flex items-center justify-center ${bg} ${text} ${className}`}>
      <BoxIcon width={iconSize} height={iconSize} />
    </div>
  )
}
