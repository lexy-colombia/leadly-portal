import { useAuth } from '../../contexts/AuthContext'
import { PageSpinner } from '@/components/atoms'
import { CategoriesTab } from './products/CategoriesTab'

/** Standalone route (/app/products/categories) -- used to be a tab inside
 * Products.tsx, pulled out so "Products" can be an expandable nav item
 * with Categorías/Brands as real sub-links (2026-08-16). CategoriesTab
 * itself didn't need any changes, it already only depended on tenantId. */
export function Categories() {
  const { profile } = useAuth()
  if (!profile?.tenant_id) return <PageSpinner />
  return <CategoriesTab tenantId={profile.tenant_id} />
}
