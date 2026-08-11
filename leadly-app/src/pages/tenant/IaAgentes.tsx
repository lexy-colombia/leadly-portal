import { useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import { connectWhatsappLineViaEmbeddedSignup } from '../../lib/api/whatsappLines'
import { launchWhatsAppEmbeddedSignup } from '../../lib/metaEmbeddedSignup'
import { LinesAndAgentsSection } from '../shared/LinesAndAgentsSection'

/** Moved out of Configuracion.tsx (2026-08-06), then reshaped from two
 * stacked Cards into tabs + tables (same day) to match a reference design
 * the user brought and to read more compactly, in line with the sidebar
 * density pass done earlier the same session. The actual tabs/tables live in
 * LinesAndAgentsSection (shared with the backoffice's Cliente "Líneas de
 * WhatsApp" tab, 2026-08-07) -- this component only supplies the
 * tenant-specific "Conectar nueva línea" Embedded Signup flow. */
export function IaAgentes() {
  const { profile } = useAuth()
  const { t } = useLanguage()
  const isAdmin = profile?.role === 'tenant_admin'
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
      {connectError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{connectError}</p>}
      <LinesAndAgentsSection
        key={reloadKey}
        tenantId={profile.tenant_id}
        canManage={isAdmin}
        connectLine={{ label: t('settings.lines.connectNew'), loading: connecting, onClick: handleConnectWhatsapp }}
      />
    </div>
  )
}
