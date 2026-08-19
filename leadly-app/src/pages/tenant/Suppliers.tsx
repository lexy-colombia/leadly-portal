import { useAuth } from '../../contexts/AuthContext'
import { PageSpinner } from '@/components/atoms'
import { SuppliersTab } from './products/SuppliersTab'

/** Standalone route (/app/products/suppliers) -- used to be the last tab
 * left inside Products.tsx after Categorías/Brands moved out (2026-08-16).
 * Pulled out the same way (2026-08-17, explicit user request: Products
 * itself should be just the catalog list, Proveedores belongs elsewhere) --
 * SuppliersTab itself didn't need any changes, it already only depended on
 * tenantId. */
export function Suppliers() {
  const { profile } = useAuth()
  if (!profile?.tenant_id) return <PageSpinner />
  return <SuppliersTab tenantId={profile.tenant_id} />
}
