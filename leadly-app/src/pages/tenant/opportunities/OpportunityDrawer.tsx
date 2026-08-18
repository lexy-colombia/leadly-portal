import { useEffect, useState, type FormEvent } from 'react'
import { createOpportunity, listStages, updateOpportunity, type OpportunityWithRelations } from '../../../lib/api/opportunities'
import { listClients } from '../../../lib/api/clients'
import type { Client, PipelineStage, OpportunityPriority } from '../../../types/domain'
import { FieldError } from '@/components/atoms'
import { ComboboxFilter, CurrencyInput } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { isNotBlank } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

const PRIORITY_LABEL: Record<OpportunityPriority, TranslationKey> = {
  baja: 'opportunities.priority.low',
  media: 'opportunities.priority.medium',
  alta: 'opportunities.priority.high',
}

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
const COMBOBOX_TRIGGER_CLASS = 'flex-1 !rounded-lg'

export function OpportunityDrawer({
  open,
  onClose,
  tenantId,
  pipelineId,
  opportunity,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  pipelineId: string | null
  /** Present when editing an existing opportunity; omitted when creating a new one. */
  opportunity?: OpportunityWithRelations | null
  onSaved: (opportunity: OpportunityWithRelations) => void
}) {
  const { t } = useLanguage()
  const [title, setTitle] = useState('')
  const [contactId, setContactId] = useState<string | null>(null)
  const [stageId, setStageId] = useState('')
  const [value, setValue] = useState('0')
  const [priority, setPriority] = useState<OpportunityPriority>('media')
  const [expectedCloseDate, setExpectedCloseDate] = useState('')
  const [description, setDescription] = useState('')
  const [contacts, setContacts] = useState<Client[]>([])
  const [stages, setStages] = useState<PipelineStage[]>([])
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTitle(opportunity?.title ?? '')
    setContactId(opportunity?.contact_id ?? null)
    setStageId(opportunity?.stage_id ?? '')
    setValue(String(opportunity?.value ?? 0))
    setPriority(opportunity?.priority ?? 'media')
    setExpectedCloseDate(opportunity?.expected_close_date ?? '')
    setDescription(opportunity?.description ?? '')
    setTouched(false)
    setFormError(null)
  }, [open, opportunity])

  useEffect(() => {
    if (!open) return
    listClients(tenantId).then(setContacts).catch(() => {})
  }, [open, tenantId])

  useEffect(() => {
    if (!open || !pipelineId) return
    listStages(pipelineId)
      .then((s) => {
        setStages(s)
        setStageId((prev) => prev || s[0]?.id || '')
      })
      .catch(() => {})
  }, [open, pipelineId])

  const titleError = touched && !isNotBlank(title) ? t('opportunities.drawer.errors.titleRequired') : undefined
  const contactError = touched && !contactId ? t('opportunities.drawer.errors.contactRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(title) || !contactId || !stageId || !pipelineId) return

    setSubmitting(true)
    try {
      const input = {
        tenant_id: tenantId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        contact_id: contactId,
        title: title.trim(),
        value: Number(value) || 0,
        priority,
        expected_close_date: expectedCloseDate || null,
        description: description.trim() || null,
      }
      const saved = opportunity ? await updateOpportunity(opportunity.id, input) : await createOpportunity(input)
      onSaved(saved as OpportunityWithRelations)
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('opportunities.drawer.errors.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={opportunity ? t('opportunities.drawer.editTitle') : t('opportunities.drawer.newTitle')}
      description={t('opportunities.drawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="opp-title">{t('opportunities.drawer.fields.title')}</Label>
          <Input
            id="opp-title"
            value={title}
            aria-invalid={!!titleError}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('opportunities.drawer.fields.titlePlaceholder')}
            className={`mt-1 ${FIELD_CLASS}`}
          />
          <FieldError message={titleError} />
        </div>

        <div>
          <Label>{t('opportunities.drawer.fields.contact')}</Label>
          <div className="mt-1">
            <ComboboxFilter
              options={contacts.map((c) => ({ id: c.id, label: c.full_name }))}
              value={contactId}
              onChange={setContactId}
              placeholder={t('opportunities.drawer.fields.contactPlaceholder')}
              searchPlaceholder={t('contacts.search.placeholder')}
              emptyLabel={t('tasks.filter.noResults')}
              className="w-full"
              triggerClassName={COMBOBOX_TRIGGER_CLASS}
            />
          </div>
          <FieldError message={contactError} />
        </div>

        <div>
          <Label htmlFor="opp-stage">{t('opportunities.drawer.fields.stage')}</Label>
          <Select value={stageId} onValueChange={setStageId}>
            <SelectTrigger id="opp-stage" className={`mt-1 w-full ${FIELD_CLASS}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {stages.map((s) => (
                <SelectItem key={s.id} value={s.id} className="text-xs">
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="opp-value">{t('opportunities.drawer.fields.value')}</Label>
            <CurrencyInput id="opp-value" step={1} value={value} onChange={(e) => setValue(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
          </div>
          <div>
            <Label htmlFor="opp-priority">{t('opportunities.drawer.fields.priority')}</Label>
            <Select value={priority} onValueChange={(v) => setPriority(v as OpportunityPriority)}>
              <SelectTrigger id="opp-priority" className={`mt-1 w-full ${FIELD_CLASS}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(PRIORITY_LABEL) as OpportunityPriority[]).map((p) => (
                  <SelectItem key={p} value={p} className="text-xs">
                    {t(PRIORITY_LABEL[p])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <Label htmlFor="opp-close-date">{t('opportunities.drawer.fields.closeDate')}</Label>
          <Input id="opp-close-date" type="date" value={expectedCloseDate} onChange={(e) => setExpectedCloseDate(e.target.value)} className={`mt-1 ${FIELD_CLASS}`} />
        </div>

        <div>
          <Label htmlFor="opp-description">{t('opportunities.drawer.fields.description')}</Label>
          <Textarea id="opp-description" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} className={`mt-1 ${TEXTAREA_CLASS}`} />
        </div>

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-4">
          <Button type="submit" disabled={submitting}>
            {submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
