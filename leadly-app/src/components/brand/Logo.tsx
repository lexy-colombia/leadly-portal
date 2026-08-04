/** Leadly wordmark: the brandbook logo is "Le" + accent-colored "a" + "dly".
 * `onDark` flips the ink color for use on the navy sidebar / auth panel. */
export function Logo({ size = 'md', onDark = false, className = '' }: { size?: 'sm' | 'md' | 'lg'; onDark?: boolean; className?: string }) {
  const sizes = { sm: 'text-lg', md: 'text-2xl', lg: 'text-4xl sm:text-5xl' }
  const ink = onDark ? 'text-white' : 'text-brand-700'

  return (
    <span className={`font-extrabold tracking-tight ${sizes[size]} ${ink} ${className}`}>
      Le<span className="text-accent-500">a</span>dly
    </span>
  )
}
