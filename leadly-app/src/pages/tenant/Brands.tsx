import { useAuth } from '../../contexts/AuthContext'
import { PageSpinner } from '@/components/atoms'
import { BrandsTab } from './products/BrandsTab'

/** Standalone route (/app/products/brands). Manages the `brands` table
 * (esquema ERP sin prefijo, 2026-08-16) -- ya asignable a un producto
 * desde ProductDrawer.tsx, que desde el cutover del mismo día lee/escribe
 * `products` (no crm_products). */
export function Brands() {
  const { profile } = useAuth()
  if (!profile?.tenant_id) return <PageSpinner />
  return <BrandsTab tenantId={profile.tenant_id} />
}
