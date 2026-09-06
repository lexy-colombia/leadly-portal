import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage } from '../contexts/LanguageContext'
import { getOpportunity, listStages, moveOpportunityToStage } from './api/opportunities'
import type { Opportunity, PipelineStage } from '../types/domain'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface PendingDecision {
  opportunityId: string
  opportunityTitle: string
  entityLabel: string
  currentStageId: string
  stages: PipelineStage[]
  onConfirmed: () => void | Promise<void>
  onStageChanged?: (opportunity: Opportunity) => void
}

/** Pedido explícito del usuario (2026-09-06): completar una tarea o cita
 * vinculada a una oportunidad no puede seguir sin efecto sobre el pipeline --
 * antes de dejar completarla, hay que preguntar OBLIGATORIAMENTE a qué etapa
 * pasa esa oportunidad (puede ser "la misma", eso ya cuenta como decisión).
 * Centralizado acá en vez de duplicado en los ~4 lugares que hoy marcan algo
 * como completada (Calendar.tsx, AppointmentDetailDrawer, OpportunityPanel,
 * ClientDetail) -- cada uno llama `requestStageDecision` en vez de completar
 * directo, y monta `dialog` una sola vez en su JSX. */
export function useOpportunityStageGate() {
  const { t } = useLanguage()
  const [pending, setPending] = useState<PendingDecision | null>(null)
  const [selectedStageId, setSelectedStageId] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  function requestStageDecision(
    opportunityId: string,
    entityLabel: string,
    onConfirmed: () => void | Promise<void>,
    onStageChanged?: (opportunity: Opportunity) => void,
  ) {
    setLoading(true)
    setLoadError(null)
    setPending({ opportunityId, entityLabel, onConfirmed, onStageChanged, opportunityTitle: '', currentStageId: '', stages: [] })
    getOpportunity(opportunityId)
      .then(async (opp) => {
        const stages = await listStages(opp.pipeline_id)
        setPending({ opportunityId, entityLabel, onConfirmed, onStageChanged, opportunityTitle: opp.title, currentStageId: opp.stage_id, stages })
        setSelectedStageId(opp.stage_id)
      })
      .catch(() => setLoadError(t('opportunities.stageGate.loadError')))
      .finally(() => setLoading(false))
  }

  function close() {
    setPending(null)
    setSelectedStageId('')
    setLoadError(null)
  }

  async function handleConfirm() {
    if (!pending) return
    setSubmitting(true)
    try {
      const stage = pending.stages.find((s) => s.id === selectedStageId)
      if (stage && stage.id !== pending.currentStageId) {
        const updated = await moveOpportunityToStage(pending.opportunityId, stage)
        pending.onStageChanged?.(updated)
      }
      await pending.onConfirmed()
      close()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t('opportunities.stageGate.loadError'))
    } finally {
      setSubmitting(false)
    }
  }

  const dialog = pending
    ? createPortal(
        <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
          <div className="absolute inset-0 animate-fade-in bg-brand-900/40" onClick={() => !submitting && close()} aria-hidden="true" />
          <div className="relative w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
            <h2 className="text-xs font-semibold text-brand-800">{t('opportunities.stageGate.title')}</h2>
            <p className="mt-2 text-xs text-brand-500">
              {t('opportunities.stageGate.description', { title: pending.opportunityTitle || pending.entityLabel })}
            </p>

            {loading && <p className="mt-4 text-xs text-brand-400">{t('common.status.loading')}</p>}

            {!loading && pending.stages.length > 0 && (
              <div className="mt-4">
                <label className="mb-1 block text-xs font-medium text-brand-400">{t('opportunities.stageGate.stageLabel')}</label>
                <Select value={selectedStageId} onValueChange={setSelectedStageId}>
                  <SelectTrigger className="w-full !h-8 !rounded-lg !text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {pending.stages.map((s) => (
                      <SelectItem key={s.id} value={s.id} className="text-xs">
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {loadError && <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{loadError}</p>}

            <div className="mt-6 flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close} disabled={submitting} className="text-xs">
                {t('opportunities.stageGate.cancel')}
              </Button>
              <Button type="button" onClick={handleConfirm} disabled={loading || submitting || pending.stages.length === 0} className="text-xs">
                {submitting ? t('common.status.processing') : t('opportunities.stageGate.confirm')}
              </Button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null

  return { requestStageDecision, dialog }
}
