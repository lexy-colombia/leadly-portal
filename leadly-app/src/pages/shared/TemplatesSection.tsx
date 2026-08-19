import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import {
  countTemplateVariables,
  createMessageTemplate,
  deleteMessageTemplate,
  editMessageTemplate,
  getTemplateHeaderImageUrl,
  listMessageTemplates,
  removeTemplateHeaderImage,
  syncTemplateStatuses,
  uploadTemplateHeaderImage,
} from '../../lib/api/templates'
import type { WhatsappMessageTemplate, WhatsappTemplateButton, WhatsappTemplateButtonType, WhatsappTemplateCategory, WhatsappTemplateStatus } from '../../types/domain'
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
import { ImageIcon, PencilIcon, PlusIcon, RefreshIcon, TrashIcon } from '@/components/atoms/icons'

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
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
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
    setSyncMessage(null)
    try {
      const result = await syncTemplateStatuses(tenantId)
      setSyncMessage(result.imported > 0 ? t('settings.templates.syncImported', { count: String(result.imported) }) : t('settings.templates.syncUpToDate'))
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
      {syncMessage && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{syncMessage}</p>}

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

const TEMPLATE_BUTTON_TYPE_KEY: Record<WhatsappTemplateButtonType, TranslationKey> = {
  QUICK_REPLY: 'settings.templates.drawer.buttons.type.quickReply',
  URL: 'settings.templates.drawer.buttons.type.url',
  PHONE_NUMBER: 'settings.templates.drawer.buttons.type.phoneNumber',
}

/** Sube inmediatamente al elegir el archivo (mismo patrón que
 * BrandLogoPicker/uploadProductImage) -- el drawer recién persiste la ruta
 * junto con el resto de la plantilla al enviar el formulario. Un archivo
 * subido y luego descartado sin guardar queda huérfano en el bucket, mismo
 * criterio de "best-effort, es inofensivo" que deleteProductImage. */
function TemplateHeaderImagePicker({
  tenantId,
  imagePath,
  onUploaded,
  onRemoved,
}: {
  tenantId: string
  imagePath: string | null
  onUploaded: (path: string) => void
  onRemoved: () => void
}) {
  const { t } = useLanguage()
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSelect(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file) return
    setError(null)
    setBusy(true)
    try {
      const path = await uploadTemplateHeaderImage(tenantId, file)
      onUploaded(path)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.templates.drawer.headerImage.errors.upload'))
    } finally {
      setBusy(false)
    }
  }

  async function handleRemove() {
    if (!imagePath) return
    setBusy(true)
    try {
      await removeTemplateHeaderImage(imagePath)
    } catch {
      /* best-effort, un objeto huérfano en el bucket es inofensivo */
    } finally {
      setBusy(false)
    }
    onRemoved()
  }

  return (
    <div>
      <Label>{t('settings.templates.drawer.headerImage.label')}</Label>
      <div className="mt-1 flex items-center gap-3">
        <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-brand-100 bg-brand-50">
          {imagePath ? (
            <img src={getTemplateHeaderImageUrl(imagePath)} alt="" className="max-h-full max-w-full object-contain" />
          ) : (
            <ImageIcon width={20} height={20} />
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? t('settings.templates.drawer.headerImage.uploading') : t(imagePath ? 'settings.templates.drawer.headerImage.change' : 'settings.templates.drawer.headerImage.upload')}
          </Button>
          {imagePath && (
            <Button type="button" variant="ghost" size="sm" className="text-red-600 hover:bg-red-50" onClick={handleRemove} disabled={busy}>
              {t('settings.templates.drawer.headerImage.remove')}
            </Button>
          )}
        </div>
      </div>
      <input ref={inputRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleSelect} />
      <p className="mt-1 text-xs text-brand-400">{t('settings.templates.drawer.headerImage.hint')}</p>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

/** Hasta 3 botones estáticos -- el límite de 3 y los sub-límites por tipo
 * (2 URL, 1 llamada) también se validan server-side en
 * whatsapp-manage-templates, esto solo evita un roundtrip inútil. */
function TemplateButtonsEditor({ buttons, onChange }: { buttons: WhatsappTemplateButton[]; onChange: (buttons: WhatsappTemplateButton[]) => void }) {
  const { t } = useLanguage()

  function updateButton(index: number, patch: Partial<WhatsappTemplateButton>) {
    onChange(buttons.map((b, i) => (i === index ? { ...b, ...patch } : b)))
  }

  return (
    <div>
      <div className="flex items-center justify-between">
        <Label>{t('settings.templates.drawer.buttons.label')}</Label>
        {buttons.length < 3 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange([...buttons, { type: 'QUICK_REPLY', text: '' }])}>
            {t('settings.templates.drawer.buttons.add')}
          </Button>
        )}
      </div>
      <p className="mt-0.5 text-xs text-brand-400">{t('settings.templates.drawer.buttons.hint')}</p>
      {buttons.length > 0 && (
        <div className="mt-1.5 space-y-2">
          {buttons.map((button, index) => (
            <div key={index} className="flex items-start gap-1.5 rounded-lg border border-brand-100 p-2">
              <div className="flex-1 space-y-1.5">
                <div className="flex gap-1.5">
                  <Select value={button.type} onValueChange={(v) => updateButton(index, { type: v as WhatsappTemplateButtonType })}>
                    <SelectTrigger className={`w-32 shrink-0 ${FIELD_CLASS}`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(['QUICK_REPLY', 'URL', 'PHONE_NUMBER'] as const).map((type) => (
                        <SelectItem key={type} value={type} className="text-xs">
                          {t(TEMPLATE_BUTTON_TYPE_KEY[type])}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    value={button.text}
                    onChange={(e) => updateButton(index, { text: e.target.value })}
                    placeholder={t('settings.templates.drawer.buttons.textPlaceholder')}
                    maxLength={25}
                    className={FIELD_CLASS}
                  />
                </div>
                {button.type === 'URL' && (
                  <Input
                    value={button.url ?? ''}
                    onChange={(e) => updateButton(index, { url: e.target.value })}
                    placeholder={t('settings.templates.drawer.buttons.urlPlaceholder')}
                    className={FIELD_CLASS}
                  />
                )}
                {button.type === 'PHONE_NUMBER' && (
                  <Input
                    value={button.phone_number ?? ''}
                    onChange={(e) => updateButton(index, { phone_number: e.target.value })}
                    placeholder={t('settings.templates.drawer.buttons.phonePlaceholder')}
                    className={FIELD_CLASS}
                  />
                )}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-red-600 hover:bg-red-50"
                onClick={() => onChange(buttons.filter((_, i) => i !== index))}
              >
                <TrashIcon width={13} height={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
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
  const [headerImagePath, setHeaderImagePath] = useState<string | null>(null)
  const [buttons, setButtons] = useState<WhatsappTemplateButton[]>([])
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
    setHeaderImagePath(editing?.header_image_path ?? null)
    setButtons(editing?.buttons ?? [])
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
  const buttonsError = touched
    ? buttons.some((b) => !b.text.trim())
      ? t('settings.templates.drawer.buttons.errors.textRequired')
      : buttons.some((b) => b.type === 'URL' && !b.url?.trim())
        ? t('settings.templates.drawer.buttons.errors.urlRequired')
        : buttons.some((b) => b.type === 'PHONE_NUMBER' && !b.phone_number?.trim())
          ? t('settings.templates.drawer.buttons.errors.phoneRequired')
          : undefined
    : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!name.trim() || !language.trim() || !bodyText.trim() || variableSamples.some((s) => !s.trim()) || buttonsError) return

    setSubmitting(true)
    try {
      const cleanedButtons = buttons.map((b) => ({ ...b, text: b.text.trim() }))
      if (editing) {
        await editMessageTemplate({
          tenant_id: tenantId,
          template_id: editing.id,
          body_text: bodyText.trim(),
          body_variable_samples: variableSamples.map((s) => s.trim()),
          header_image_path: headerImagePath,
          buttons: cleanedButtons,
        })
      } else {
        await createMessageTemplate({
          tenant_id: tenantId,
          name: name.trim(),
          category,
          language: language.trim(),
          body_text: bodyText.trim(),
          body_variable_samples: variableSamples.map((s) => s.trim()),
          header_image_path: headerImagePath,
          buttons: cleanedButtons,
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

        <TemplateHeaderImagePicker tenantId={tenantId} imagePath={headerImagePath} onUploaded={setHeaderImagePath} onRemoved={() => setHeaderImagePath(null)} />

        <TemplateButtonsEditor buttons={buttons} onChange={setButtons} />
        <FieldError message={buttonsError} />

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}
      </form>
    </Drawer>
  )
}
