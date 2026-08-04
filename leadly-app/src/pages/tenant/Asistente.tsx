import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { connectWhatsappLineViaEmbeddedSignup, listWhatsappLinesByTenant } from '../../lib/api/whatsappLines'
import { launchWhatsAppEmbeddedSignup } from '../../lib/metaEmbeddedSignup'
import type { WhatsappLine, WhatsappLineStatus } from '../../types/domain'
import { Badge, Button, Card, EmptyState, PageSpinner, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'
import { AiSparkleIcon, PhoneIcon, PlusIcon } from '../../components/icons'
import { AiAssistantDrawer } from '../shared/AiAssistantDrawer'

const LINE_STATUS_LABEL: Record<WhatsappLineStatus, string> = {
  pending_verification: 'Pendiente de verificación',
  active: 'Activa',
  suspended: 'Suspendida',
}

const LINE_STATUS_TONE: Record<WhatsappLineStatus, 'success' | 'warning' | 'danger'> = {
  pending_verification: 'warning',
  active: 'success',
  suspended: 'danger',
}

export function Asistente() {
  const { profile } = useAuth()
  const [lines, setLines] = useState<WhatsappLine[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [drawer, setDrawer] = useState<{ open: boolean; line: WhatsappLine | null }>({ open: false, line: null })

  function reload() {
    if (!profile?.tenant_id) return
    listWhatsappLinesByTenant(profile.tenant_id)
      .then(setLines)
      .catch((err) => setError(err.message ?? 'No se pudieron cargar las líneas.'))
  }

  useEffect(reload, [profile?.tenant_id])

  async function handleConnectWhatsapp() {
    setError(null)
    setConnecting(true)
    try {
      const { code, wabaId, phoneNumberId } = await launchWhatsAppEmbeddedSignup()
      if (!wabaId || !phoneNumberId) {
        throw new Error('Meta no devolvió los datos de tu cuenta de WhatsApp. Intenta de nuevo.')
      }
      await connectWhatsappLineViaEmbeddedSignup(code, wabaId, phoneNumberId, 'WhatsApp')
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo conectar tu WhatsApp.')
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-brand-800 sm:text-2xl">Asistente de IA</h1>
          <p className="text-sm text-brand-400">Configura cómo responde tu asistente en cada línea de WhatsApp.</p>
        </div>
        {profile?.role === 'tenant_admin' && (
          <Button variant="secondary" onClick={handleConnectWhatsapp} disabled={connecting}>
            <PlusIcon width={16} height={16} /> {connecting ? 'Conectando…' : 'Conectar tu WhatsApp'}
          </Button>
        )}
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!lines && !error && <PageSpinner />}

      {lines && lines.length === 0 && (
        <Card>
          <EmptyState>
            Todavía no tienes ninguna línea de WhatsApp conectada. Usa "Conectar tu WhatsApp" para vincular tu propia cuenta de
            WhatsApp Business (los costos de Meta quedan a tu nombre), o contacta a Leadly para que te asignen una manualmente.
          </EmptyState>
        </Card>
      )}

      {lines && lines.length > 0 && (
        <Table>
          <THead>
            <tr>
              <TH>Línea</TH>
              <TH>Estado</TH>
              <TH className="text-right">Acciones</TH>
            </tr>
          </THead>
          <TBody>
            {lines.map((line) => (
              <TRow key={line.id}>
                <TD className="font-medium text-brand-800">
                  <span className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600">
                      <PhoneIcon width={16} height={16} />
                    </span>
                    {line.display_name}
                  </span>
                </TD>
                <TD>
                  <Badge tone={LINE_STATUS_TONE[line.status]}>{LINE_STATUS_LABEL[line.status]}</Badge>
                </TD>
                <TD className="text-right">
                  <Button variant="secondary" onClick={() => setDrawer({ open: true, line })} className="!px-3 !py-1.5 text-xs">
                    <AiSparkleIcon width={14} height={14} /> Configurar asistente
                  </Button>
                </TD>
              </TRow>
            ))}
          </TBody>
        </Table>
      )}

      {drawer.line && (
        <AiAssistantDrawer
          open={drawer.open}
          onClose={() => setDrawer({ open: false, line: null })}
          whatsappLineId={drawer.line.id}
          lineName={drawer.line.display_name}
        />
      )}
    </div>
  )
}
