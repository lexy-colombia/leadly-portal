import { useEffect, useState, type FormEvent } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { countTemplateVariables, createMessageTemplate, deleteMessageTemplate, editMessageTemplate, listMessageTemplates, syncTemplateStatuses } from '../../lib/api/templates'
import type { WhatsappMessageTemplate, WhatsappTemplateCategory, WhatsappTemplateStatus } from '../../types/domain'
import { PageSpinner, FieldError } from '@/components/atoms'
import { EmptyState } from '@/components/molecules'
import { ConfirmDialog, Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PencilIcon, PlusIcon, RefreshIcon, TrashIcon } from '@/components/atoms/icons'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const TEXTAREA_CLASS = '!rounded-lg !py-1.5 !text-xs'
const FORM_ID = 'new-template-form'

const CATEGORY_KEY: Record<WhatsappTemplateCategory, TranslationKey> = {
  MARKETING: 'settings.templates.category.marketing',
  UTILITY: 'settings.templates.category.utility',
  AUTHENTICATION: 'settings.templates.category.authentication',
}

const STATUS_KEY: Record<WhatsappTemplateStatus, TranslationKey> = {
  PENDING: 'settings.templates.status.pending',
  APPROVED: 'settings.templates.status.approved',
  REJECTED: 'settings.templates.status.rejected',
  PAUSED: 'settings.templates.status.paused',
  DISABLED: 'settings.templates.status.disabled',
}

const STATUS_BADGE_CLASS: Record<WhatsappTemplateStatus, string> = {
  PENDING: 'border-transparent bg-amber-100 text-amber-700',
  APPROVED: 'border-transparent bg-emerald-100 text-emerald-700',
  REJECTED: 'border-transparent bg-red-100 text-red-700',
  PAUSED: 'border-transparent bg-slate-100 text-slate-600',
  DISABLED: 'border-transparent bg-slate-100 text-slate-600',
}

/** Tercera pestaña de LinesAndAgentsSection -- plantillas de WhatsApp (HSM)
 * propias del tenant, ver CLAUDE.md Fase 1 de "iniciar conversaciones". A
 * diferencia de Líneas/Agentes, acá no hay "editar": una plantilla enviada a
 * Meta no se puede modificar (solo eliminar localmente y crear una nueva). */
export function TemplatesSection({ tenantId, canManage }: { tenantId: string; canManage: boolean }) {
  const { t } = useLanguage()
  const [templates, setTemplates] = useState<WhatsappMessageTemplate[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<WhatsappMessageTemplate | null>(null)
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  function reload() {
    listMessageTemplates(tenantId)
      .then(setTemplates)
      .catch((err) => setError(err.message ?? t('settings.templates.errors.load')))
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(reload, [tenantId])

  async function handleSync() {
    setSyncing(true)
    setError(null)
    try {
      await syncTemplateStatuses(tenantId)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.templates.errors.sync'))
    } finally {
      setSyncing(false)
    }
  }

  async function handleDelete(id: string) {
    setDeletingId(id)
    setDeleteError(null)
    try {
      await deleteMessageTemplate(id)
      setConfirmingDeleteId(null)
      reload()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : t('settings.templates.errors.delete'))
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-3.5">
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={handleSync} disabled={syncing}>
          <RefreshIcon width={14} height={14} /> {syncing ? t('settings.templates.syncing') : t('settings.templates.syncStatus')}
        </Button>
        {canManage && (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <PlusIcon width={14} height={14} /> {t('settings.templates.newTemplate')}
          </Button>
        )}
      </div>

      {!templates && !error && <PageSpinner />}
      {templates && templates.length === 0 && <EmptyState>{t('settings.templates.empty')}</EmptyState>}
      {templates && templates.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('settings.templates.table.name')}</TableHead>
                <TableHead>{t('settings.templates.table.category')}</TableHead>
                <TableHead>{t('settings.templates.table.language')}</TableHead>
                <TableHead>{t('settings.templates.table.status')}</TableHead>
                <TableHead className="text-right">{t('settings.templates.table.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {templates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell className="text-xs font-medium text-brand-800">{template.name}</TableCell>
                  <TableCell className="text-xs text-brand-500">{t(CATEGORY_KEY[template.category])}</TableCell>
                  <TableCell className="text-xs text-brand-500">{template.language}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className={STATUS_BADGE_CLASS[template.status]}>
                      {t(STATUS_KEY[template.status])}
                    </Badge>
                    {template.status === 'REJECTED' && template.rejected_reason && (
                      <p className="mt-1 max-w-xs text-[11px] text-red-500">{template.rejected_reason}</p>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {canManage && (
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon-xs" onClick={() => setEditingTemplate(template)}>
                          <PencilIcon width={13} height={13} />
                        </Button>
                        <Button variant="ghost" size="icon-xs" className="text-red-600 hover:bg-red-50" onClick={() => setConfirmingDeleteId(template.id)}>
                          <TrashIcon width={13} height={13} />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {templates && templates.length > 0 && <p className="text-xs text-brand-400">{t('settings.templates.footerNote')}</p>}

      <CreateTemplateDrawer
        open={createOpen || !!editingTemplate}
        editing={editingTemplate}
        onClose={() => {
          setCreateOpen(false)
          setEditingTemplate(null)
        }}
        tenantId={tenantId}
        onCreated={() => {
          setCreateOpen(false)
          setEditingTemplate(null)
          reload()
        }}
      />

      <ConfirmDialog
        open={!!confirmingDeleteId}
        onClose={() => {
          setConfirmingDeleteId(null)
          setDeleteError(null)
        }}
        onConfirm={() => confirmingDeleteId && handleDelete(confirmingDeleteId)}
        loading={!!deletingId}
        error={deleteError}
        title={t('settings.templates.deleteTemplate.title')}
        description={t('settings.templates.deleteTemplate.description', { name: templates?.find((tpl) => tpl.id === confirmingDeleteId)?.name ?? '' })}
        confirmLabel={t('settings.templates.deleteTemplate.confirm')}
      />
    </div>
  )
}

function CreateTemplateDrawer({
  open,
  editing,
  onClose,
  tenantId,
  onCreated,
}: {
  open: boolean
  /** Cuando viene una plantilla, el drawer edita su cuerpo (y reenvía a
   * revisión) en vez de crear una nueva -- nombre/categoría/idioma son la
   * identidad de la plantilla en el WABA, no se pueden cambiar acá. */
  editing: WhatsappMessageTemplate | null
  onClose: () => void
  tenantId: string
  onCreated: () => void
}) {
  const { t } = useLanguage()
  const [name, setName] = useState('')
  const [category, setCategory] = useState<WhatsappTemplateCategory>('UTILITY')
  const [language, setLanguage] = useState('es')
  const [bodyText, setBodyText] = useState('')
  const [variableSamples, setVariableSamples] = useState<string[]>([])
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(editing?.name ?? '')
    setCategory(editing?.category ?? 'UTILITY')
    setLanguage(editing?.language ?? 'es')
    setBodyText(editing?.body_text ?? '')
    setVariableSamples([])
    setTouched(false)
    setFormError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing?.id])

  const variableCount = countTemplateVariables(bodyText)
  useEffect(() => {
    setVariableSamples((prev) => Array.from({ length: variableCount }, (_, i) => prev[i] ?? ''))
  }, [variableCount])

  const nameError = touched && !name.trim() ? t('settings.templates.drawer.errors.nameRequired') : undefined
  const languageError = touched && !language.trim() ? t('settings.templates.drawer.errors.languageRequired') : undefined
  const bodyError = touched && !bodyText.trim() ? t('settings.templates.drawer.errors.bodyRequired') : undefined
  const samplesError = touched && variableSamples.some((s) => !s.trim()) ? t('settings.templates.drawer.errors.samplesRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!name.trim() || !language.trim() || !bodyText.trim() || variableSamples.some((s) => !s.trim())) return

    setSubmitting(true)
    try {
      if (editing) {
        await editMessageTemplate({
          tenant_id: tenantId,
          template_id: editing.id,
          body_text: bodyText.trim(),
          body_variable_samples: variableSamples.map((s) => s.trim()),
        })
      } else {
        await createMessageTemplate({
          tenant_id: tenantId,
          name: name.trim(),
          category,
          language: language.trim(),
          body_text: bodyText.trim(),
          body_variable_samples: variableSamples.map((s) => s.trim()),
        })
      }
      onCreated()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('settings.templates.errors.create'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={editing ? t('settings.templates.drawer.editTitle') : t('settings.templates.drawer.title')}
      description={editing ? t('settings.templates.drawer.editDescription') : t('settings.templates.drawer.description')}
      footer={
        <div className="flex gap-2">
          <Button type="submit" form={FORM_ID} disabled={submitting}>
            {submitting ? t('common.actions.saving') : editing ? t('settings.templates.drawer.editSubmit') : t('settings.templates.drawer.submit')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      }
    >
      <form id={FORM_ID} onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="template-name">{t('settings.templates.drawer.nameLabel')}</Label>
          <Input
            id="template-name"
            value={name}
            disabled={!!editing}
            aria-invalid={!!nameError}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('settings.templates.drawer.namePlaceholder')}
            className={`mt-1 ${FIELD_CLASS}`}
          />
          <p className="mt-1 text-xs text-brand-400">{t('settings.templates.drawer.nameHint')}</p>
          <FieldError message={nameError} />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="template-category">{t('settings.templates.drawer.categoryLabel')}</Label>
            <Select value={category} onValueChange={(v) => setCategory(v as WhatsappTemplateCategory)} disabled={!!editing}>
              <SelectTrigger id="template-category" className={`mt-1 w-full ${FIELD_CLASS}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(['UTILITY', 'MARKETING', 'AUTHENTICATION'] as const).map((cat) => (
                  <SelectItem key={cat} value={cat} className="text-xs">
                    {t(CATEGORY_KEY[cat])}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="template-language">{t('settings.templates.drawer.languageLabel')}</Label>
            <Input
              id="template-language"
              value={language}
              disabled={!!editing}
              aria-invalid={!!languageError}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder={t('settings.templates.drawer.languagePlaceholder')}
              className={`mt-1 ${FIELD_CLASS}`}
            />
            <FieldError message={languageError} />
          </div>
        </div>

        <div>
          <Label htmlFor="template-body">{t('settings.templates.drawer.bodyLabel')}</Label>
          <Textarea
            id="template-body"
            rows={5}
            value={bodyText}
            aria-invalid={!!bodyError}
            onChange={(e) => setBodyText(e.target.value)}
            placeholder={t('settings.templates.drawer.bodyPlaceholder')}
            className={`mt-1 ${TEXTAREA_CLASS}`}
          />
          <p className="mt-1 text-xs text-brand-400">{t('settings.templates.drawer.bodyHint')}</p>
          <FieldError message={bodyError} />
        </div>

        {variableCount > 0 && (
          <div>
            <Label>{t('settings.templates.drawer.samplesLabel')}</Label>
            <p className="mt-0.5 text-xs text-brand-400">{t('settings.templates.drawer.samplesHint')}</p>
            <div className="mt-1.5 space-y-2">
              {Array.from({ length: variableCount }).map((_, i) => (
                <Input
                  key={i}
                  value={variableSamples[i] ?? ''}
                  onChange={(e) =>
                    setVariableSamples((prev) => {
                      const next = [...prev]
                      next[i] = e.target.value
                      return next
                    })
                  }
                  placeholder={t('inbox.newConv.templateVariable', { n: i + 1 })}
                  className={FIELD_CLASS}
                />
              ))}
            </div>
            <FieldError message={samplesError} />
          </div>
        )}

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
      </form>
    </Drawer>
  )
}
