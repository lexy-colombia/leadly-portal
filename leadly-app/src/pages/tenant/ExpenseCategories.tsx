import { useAuth } from '../../contexts/AuthContext'
import { PageSpinner } from '@/components/atoms'
import { CategoriesTab } from './expenses/CategoriesTab'

export function ExpenseCategories() {
  const { profile } = useAuth()
  if (!profile?.tenant_id) return <PageSpinner />
  return <CategoriesTab tenantId={profile.tenant_id} />
}
