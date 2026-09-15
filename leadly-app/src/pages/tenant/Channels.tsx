import { useState } from 'react'
import { useAuth, usePermission } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { connectWhatsappLineViaEmbeddedSignup } from '../../lib/api/whatsappLines'
import { launchWhatsAppEmbeddedSignup } from '../../lib/metaEmbeddedSignup'
import { LinesAndAgentsSection } from '../shared/LinesAndAgentsSection'

/** Canales: los números de WhatsApp del comercio y su conexión con Meta.
 *
 * Separado de "IA & Agentes" el 2026-09-13 (pedido explícito del usuario:
 * "es algo confuso como está"). Esa pantalla mezclaba tres cosas distintas
 * -- líneas de WhatsApp, agentes de IA y plantillas de Meta -- y dos de las
 * tres no son de IA: una línea es el CANAL por donde entra la conversación,
 * la use un agente de IA o una persona. Las plantillas se fueron a Campañas,
 * que es donde se usan. */
export function Channels() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  // Conectar/desconectar una línea es tocar el canal por donde entra todo el
  // negocio: va por permiso propio (`channels.manage`), no por "es admin".
  // Un tenant_admin lo tiene siempre, ver has_permission/listMyPermissionKeys.
  const canManage = usePermission('channels.manage')
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  async function handleConnectWhatsapp() {
    setConnectError(null)
    setConnecting(true)
    try {
      const { code, wabaId, phoneNumberId } = await launchWhatsAppEmbeddedSignup()
      if (!wabaId || !phoneNumberId) {
        throw new Error(t('settings.lines.connectErrors.noData'))
      }
      await connectWhatsappLineViaEmbeddedSignup(code, wabaId, phoneNumberId, 'WhatsApp')
      setReloadKey((k) => k + 1)
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : t('settings.lines.connectErrors.generic'))
    } finally {
      setConnecting(false)
    }
  }

  if (!profile?.tenant_id) return null

  return (
    <div className="space-y-3">
      {connectError && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{connectError}</p>}
      <LinesAndAgentsSection
        key={reloadKey}
        tenantId={profile.tenant_id}
        canManage={canManage}
        tabs={['lineas']}
        connectLine={{ label: t('settings.lines.connectNew'), loading: connecting, onClick: handleConnectWhatsapp }}
      />
    </div>
  )
}
