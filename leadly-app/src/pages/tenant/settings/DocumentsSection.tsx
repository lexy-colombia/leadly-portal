import { useState } from 'react'
import { updateTenantPosSettings } from '../../../lib/api/tenants'
import type { Tenant } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Switch } from '@/components/atoms'
import { Card, CardSection } from '@/components/molecules'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** "Documentos y tickets" category -- impresión de tickets del POS (ancho de
 * papel, auto-impresión, mensaje al pie). Vivía antes dentro de "Punto de
 * venta" (PosSettingsSection) -- separado a pedido explícito del usuario,
 * misma lógica/servicio (`updateTenantPosSettings`), solo cambia dónde vive
 * en la navegación. Ancho de papel y auto-impresión son instant-apply
 * (mismo criterio que el resto de switches/selects de Configuración); el
 * mensaje al pie es texto libre, así que sí necesita su propio botón
 * "Guardar", deshabilitado mientras no haya nada distinto de lo guardado. */
export function DocumentsSection({ tenant, onSaved }: { tenant: Tenant; onSaved: (tenant: Tenant) => void }) {
  const { t } = useLanguage()
  const [savingToggle, setSavingToggle] = useState<'width' | 'autoPrint' | null>(null)
  const [footerDraft, setFooterDraft] = useState(tenant.pos_receipt_footer_message ?? '')
  const [savingFooter, setSavingFooter] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save(input: Parameters<typeof updateTenantPosSettings>[1], which: typeof savingToggle) {
    setSavingToggle(which)
    setError(null)
    try {
      const updated = await updateTenantPosSettings(tenant.id, input)
      onSaved(updated)
      if (which === null) setFooterDraft(updated.pos_receipt_footer_message ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.pos.errors.save'))
    } finally {
      setSavingToggle(null)
    }
  }

  const footerDirty = footerDraft !== (tenant.pos_receipt_footer_message ?? '')

  async function handleSaveFooter() {
    setSavingFooter(true)
    setError(null)
    try {
      const updated = await updateTenantPosSettings(tenant.id, { pos_receipt_footer_message: footerDraft.trim() || null })
      onSaved(updated)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.pos.errors.save'))
    } finally {
      setSavingFooter(false)
    }
  }

  return (
    <Card padded={false}>
      <CardSection title={t('settings.documents.title')} description={t('settings.documents.description')}>
        <div className="space-y-3.5">
          <div className="flex items-center justify-between gap-3">
            <Label className="text-sm font-normal text-brand-700">{t('settings.pos.printing.paperWidth')}</Label>
            <Select
              value={tenant.pos_receipt_paper_width}
              onValueChange={(v) => save({ pos_receipt_paper_width: v as '58mm' | '80mm' }, 'width')}
              disabled={savingToggle === 'width'}
            >
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="58mm">58mm</SelectItem>
                <SelectItem value="80mm">80mm</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm font-medium text-brand-700">{t('settings.pos.printing.autoPrintLabel')}</p>
              <p className="text-xs text-brand-400">{t('settings.pos.printing.autoPrintDescription')}</p>
            </div>
            <Switch checked={tenant.pos_auto_print} disabled={savingToggle === 'autoPrint'} onChange={(v) => save({ pos_auto_print: v }, 'autoPrint')} />
          </div>

          <div>
            <Label htmlFor="receipt-footer">{t('settings.pos.printing.footerLabel')}</Label>
            <Textarea
              id="receipt-footer"
              rows={2}
              value={footerDraft}
              onChange={(e) => setFooterDraft(e.target.value)}
              placeholder={t('settings.pos.printing.footerPlaceholder')}
              className="mt-1"
            />
            {footerDirty && (
              <Button type="button" size="sm" className="mt-2" disabled={savingFooter} onClick={handleSaveFooter}>
                {savingFooter ? t('common.actions.saving') : t('settings.pos.printing.save')}
              </Button>
            )}
          </div>

          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>
      </CardSection>
    </Card>
  )
}
