import { useAuth } from '../../contexts/AuthContext'
import { LinesAndAgentsSection } from '../shared/LinesAndAgentsSection'

/** IA & Agentes: los asistentes del comercio y sus habilidades, nada más.
 *
 * Hasta el 2026-09-13 esta pantalla también tenía las líneas de WhatsApp y
 * las plantillas de Meta, que no son de IA (pedido explícito del usuario:
 * "es algo confuso como está"). Las líneas se fueron a "Canales" y las
 * plantillas a "Campañas", que es donde se usan. Un agente es reutilizable
 * entre líneas desde el 2026-08-06, así que configurarlo junto al canal
 * nunca fue una relación 1:1 de todos modos. */
export function AiAgents() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'tenant_admin'

  if (!profile?.tenant_id) return null

  return <LinesAndAgentsSection tenantId={profile.tenant_id} canManage={isAdmin} manageSkills={isAdmin} tabs={['agentes']} />
}
