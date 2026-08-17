import type { ReactNode } from 'react'

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-5 py-10 text-center text-sm text-brand-400">{children}</p>
}
