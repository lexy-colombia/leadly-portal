import { useEffect, useState } from 'react'
import { createAndSendCreditNote } from '../../../lib/api/salesInvoices'
import { CREDIT_NOTE_REASONS, CREDIT_NOTE_REASON_LABEL_KEY } from '../../../lib/creditNoteReasons'
import type { CreditNoteReasonCode } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguage } from '../../../contexts/LanguageContext'

const MIN_REASON_LENGTH = 20

/** Emite una nota crédito DIAN sobre una factura ya aceptada -- pedido
 * explícito del usuario 2026-09-09, apenas después de confirmar que el
 * envío de facturas reales ya funciona. Deliberadamente simple (monto +
 * motivo + descripción, sin editor de ítems, ver comentario de cabecera de
 * la migración sales_credit_notes.sql): el servidor calcula el desglose de
 * impuesto solo con la tarifa que ya tenía la factura, y rechaza si esa
 * factura mezcla tarifas -- este drawer no valida nada de eso por
 * adelantado, muestra tal cual el error que devuelva el servidor. */
export function CreditNoteDrawer({
  open,
  onClose,
  invoiceId,
  availableBalance,
  availableBalanceLabel,
  onCreated,
}: {
  open: boolean
  onClose: () => void
  invoiceId: string
  availableBalance: number
  availableBalanceLabel: string
  onCreated: (creditNote: { status: 'sent' | 'error' }) => void
}) {
  const { t } = useLanguage()
  const [amount, setAmount] = useState('')
  const [reasonCode, setReasonCode] = useState<CreditNoteReasonCode>('2')
  const [description, setDescription] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setAmount(availableBalance > 0 ? String(availableBalance) : '')
    setReasonCode('2')
    setDescription('')
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoiceId])

  const amountNumber = Number(amount)
  const amountValid = amount.trim() !== '' && Number.isFinite(amountNumber) && amountNumber > 0
  const descriptionValid = description.trim().length >= MIN_REASON_LENGTH
  const canSubmit = amountValid && descriptionValid && !submitting

  async function handleSubmit() {
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await createAndSendCreditNote(invoiceId, {
        amount: amountNumber,
        reasonCode,
        reasonDescription: description.trim(),
      })
      if (result.status === 'error' || result.status === 'rejected') {
        // 'rejected' ya es el veredicto real de la DIAN (el propio envío
        // lo consulta antes de responder, ver sendCreditNoteToDian.ts).
        setError((result.status === 'rejected' ? result.rejectionDetail : result.faultReason) ?? t('einvoicing.creditNote.error'))
        // La nota quedó creada igual -- se avisa al padre para que
        // refresque el listado, no solo cuando sale bien.
        onCreated({ status: 'error' })
        return
      }
      onCreated({ status: 'sent' })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('einvoicing.creditNote.error'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={t('einvoicing.creditNote.drawerTitle')} description={t('einvoicing.creditNote.drawerDescription')}>
      <div className="space-y-4">
        <div>
          <label htmlFor="credit-note-amount" className="mb-1 block text-xs font-medium text-brand-700">
            {t('einvoicing.creditNote.amountLabel')}
          </label>
          <Input id="credit-note-amount" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="!h-8 !text-sm" />
          <p className="mt-1 text-xs text-brand-400">{t('einvoicing.creditNote.amountHint', { amount: availableBalanceLabel })}</p>
        </div>

        <div>
          <label htmlFor="credit-note-reason" className="mb-1 block text-xs font-medium text-brand-700">
            {t('einvoicing.creditNote.reasonLabel')}
          </label>
          <Select value={reasonCode} onValueChange={(v) => setReasonCode(v as CreditNoteReasonCode)}>
            <SelectTrigger id="credit-note-reason" className="w-full !h-8 !text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CREDIT_NOTE_REASONS.map((code) => (
                <SelectItem key={code} value={code} className="text-sm">
                  {t(CREDIT_NOTE_REASON_LABEL_KEY[code])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <label htmlFor="credit-note-description" className="mb-1 block text-xs font-medium text-brand-700">
            {t('einvoicing.creditNote.descriptionLabel')}
          </label>
          <Textarea id="credit-note-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} className="!text-sm" />
          <p className="mt-1 text-xs text-brand-400">{t('einvoicing.creditNote.descriptionHint')}</p>
        </div>

        {error && <FieldError message={error} />}

        <div className="flex items-center gap-2 border-t border-brand-100 pt-4">
          <Button type="button" onClick={handleSubmit} disabled={!canSubmit}>
            {submitting ? t('einvoicing.creditNote.submitting') : t('einvoicing.creditNote.submit')}
          </Button>
        </div>
      </div>
    </Drawer>
  )
}
