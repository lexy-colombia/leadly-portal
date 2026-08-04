import type { HTMLAttributes, ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from 'react'

/** Minimal styled table primitives shared by every data list in the app
 * (Clientes, Líneas de WhatsApp, Usuarios, ...) instead of each page
 * re-styling its own <table>. Deliberately light on grid lines -- rows are
 * separated by hairline dividers and a hover wash, not a boxed grid. */
export function Table({
  className = '',
  bare = false,
  children,
  ...props
}: TableHTMLAttributes<HTMLTableElement> & { bare?: boolean }) {
  return (
    <div
      className={bare ? 'overflow-x-auto' : 'overflow-x-auto rounded-2xl border border-brand-100/70 bg-white'}
    >
      <table className={`w-full text-left text-sm ${className}`} {...props}>
        {children}
      </table>
    </div>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-brand-100/70">{children}</thead>
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-brand-50">{children}</tbody>
}

export function TH({ className = '', children, ...props }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th className={`px-4 py-3 text-xs font-medium text-brand-400 ${className}`} {...props}>
      {children}
    </th>
  )
}

export function TD({ className = '', children, ...props }: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={`px-4 py-3.5 text-brand-700 ${className}`} {...props}>
      {children}
    </td>
  )
}

export function TRow({ className = '', clickable = false, ...props }: HTMLAttributes<HTMLTableRowElement> & { clickable?: boolean }) {
  return (
    <tr
      className={`transition-colors duration-100 ${clickable ? 'cursor-pointer hover:bg-accent-50/50' : ''} ${className}`}
      {...props}
    />
  )
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="px-5 py-10 text-center text-sm text-brand-400">{children}</p>
}
