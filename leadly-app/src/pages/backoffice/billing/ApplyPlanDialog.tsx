import { useEffect, useState } from 'react'
import { applyPlanToTenant, previewApplyPlanToTenant, type PlanApplyPreview } from '../../../lib/api/billing'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'
import { moduleLabelKey } from '../../../lib/planModules'

/** Shows what applying the plan would change in the tenant's modules (from
 * preview_apply_plan_to_tenant, nothing written) and only runs
 * apply_plan_to_tenant after an explicit confirm. Manual modules are never
 * removed unless the superadmin ticks "replace manual modules" -- the
 * default is always the non-destructive path. */
export function ApplyPlanDialog({
  open,
  onClose,
  tenantId,
  onApplied,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  onApplied: () => void
}) {
  const { t } = useLanguage()
  const toast = useToast()
  const [preview, setPreview] = useState<PlanApplyPreview | null>(null)
  const [replaceManual, setReplaceManual] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!open) return
    setPreview(null)
    setReplaceManual(false)
    setError(null)
    previewApplyPlanToTenant(tenantId)
      .then(setPreview)
      .catch((err) => setError(err instanceof Error ? err.message : t('backoffice.applyPlan.errors.preview')))
  }, [open, tenantId, t])

  function labelOf(moduleKey: string): string {
    const key = moduleLabelKey(moduleKey)
    return key ? t(key) : moduleKey
  }

  async function handleApply() {
    setApplying(true)
    setError(null)
    try {
      const result = await applyPlanToTenant(tenantId, replaceManual)
      toast.success(t('backoffice.applyPlan.success', { added: String(result.added.length), removed: String(result.removed.length) }))
      onApplied()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('backoffice.applyPlan.errors.apply'))
    } finally {
      setApplying(false)
    }
  }

  function renderList(keys: string[]) {
    return keys.length === 0 ? (
      <p className="text-xs text-brand-400">{t('backoffice.applyPlan.none')}</p>
    ) : (
      <ul className="flex flex-wrap gap-1.5">
        {keys.map((k) => (
          <li key={k} className="rounded-md bg-brand-50 px-2 py-0.5 text-xs text-brand-700">
            {labelOf(k)}
          </li>
        ))}
      </ul>
    )
  }

  const nothingToChange = !!preview && preview.to_add.length === 0 && (!replaceManual || preview.to_remove_if_replace.length === 0)

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !applying && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('backoffice.applyPlan.title')}</DialogTitle>
          <DialogDescription>{t('backoffice.applyPlan.description')}</DialogDescription>
        </DialogHeader>

        {!preview && !error && <p className="text-xs text-brand-400">{t('common.actions.loading')}</p>}

        {preview && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs font-semibold text-emerald-700">{t('backoffice.applyPlan.toAdd')}</p>
              {renderList(preview.to_add)}
            </div>
            <div>
              <p className="mb-1 text-xs font-semibold text-brand-700">{t('backoffice.applyPlan.keptManual')}</p>
              {renderList(preview.kept_manual)}
            </div>
            <div className={replaceManual ? 'rounded-lg border border-red-200 bg-red-50 p-2.5' : ''}>
              <p className="mb-1 text-xs font-semibold text-red-700">{t('backoffice.applyPlan.toRemove')}</p>
              {renderList(preview.to_remove_if_replace)}
              <label className="mt-2 flex items-start gap-2 text-xs text-brand-700">
                <Checkbox checked={replaceManual} onCheckedChange={(c) => setReplaceManual(c === true)} className="mt-0.5" />
                <span>{t('backoffice.applyPlan.replaceManual')}</span>
              </label>
            </div>
            {nothingToChange && <p className="text-xs text-brand-400">{t('backoffice.applyPlan.nothingToChange')}</p>}
          </div>
        )}

        {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose} disabled={applying}>
            {t('common.actions.cancel')}
          </Button>
          <Button type="button" onClick={handleApply} disabled={!preview || applying}>
            {applying ? t('backoffice.applyPlan.applying') : t('backoffice.applyPlan.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
