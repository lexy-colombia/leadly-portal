import { useAuth } from '../../contexts/AuthContext'
import { PageSpinner } from '@/components/atoms'
import { UsersSection } from './settings/UsersSection'

/** Vista propia (antes vivía como sección adentro de Configuración) --
 * pedido explícito del usuario: Usuarios y Roles y permisos deben tener su
 * propio ítem en el menú lateral, y ambos son admin-only (RequireRole en
 * App.tsx, no solo un check interno). Sin Card envolvente (pedido explícito
 * del usuario) -- mismo criterio que Clients.tsx/Credit.tsx, la tabla ya
 * trae su propio borde, no hace falta un recuadro general alrededor. */
export function Users() {
  const { profile } = useAuth()
  if (!profile?.tenant_id) return <PageSpinner />

  return (
    <div className="animate-fade-in">
      <UsersSection tenantId={profile.tenant_id} />
    </div>
  )
}
