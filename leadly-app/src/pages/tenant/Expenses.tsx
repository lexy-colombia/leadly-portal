import { useAuth } from '../../contexts/AuthContext'
import { PageSpinner } from '@/components/atoms'
import { ExpensesTab } from './expenses/ExpensesTab'

export function Expenses() {
  const { profile } = useAuth()
  if (!profile?.tenant_id) return <PageSpinner />
  return <ExpensesTab tenantId={profile.tenant_id} />
}
