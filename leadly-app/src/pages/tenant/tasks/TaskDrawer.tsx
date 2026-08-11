import { useEffect, useRef, useState, type FormEvent } from 'react'
import { createTask, TASK_PRIORITY_KEY, updateTask } from '../../../lib/api/tasks'
import type { TaskWithRelations } from '../../../lib/api/tasks'
import { listContacts } from '../../../lib/api/contacts'
import { listProfilesByTenant } from '../../../lib/api/users'
import { getAttachmentSignedUrl, listAttachmentsForTask, uploadTaskAttachment, validateTaskAttachmentFile } from '../../../lib/api/attachments'
import type { CrmAttachment, CrmContact, Profile, TaskPriority } from '../../../types/domain'
import { Button, Drawer, FieldError, Input, Label, Select, Textarea } from '../../../components/ui'
import { FileIcon, ImageIcon, PaperclipIcon } from '../../../components/icons'
import { isNotBlank } from '../../../lib/validation'
import { useLanguage } from '../../../contexts/LanguageContext'

function formatFileSize(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.round(bytes / 1000)} KB`
}

/** Attachments only make sense once a task actually exists in the DB
 * (crm_attachments.task_id needs a real row to point at) -- so this section
 * only renders for an existing task, never in the "create" form. */
function TaskAttachments({ tenantId, taskId }: { tenantId: string; taskId: string }) {
  const { t } = useLanguage()
  const inputRef = useRef<HTMLInputElement>(null)
  const [attachments, setAttachments] = useState<CrmAttachment[] | null>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function reload() {
    listAttachmentsForTask(taskId).then(setAttachments).catch(() => setAttachments([]))
  }

  useEffect(reload, [taskId])

  async function handleSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file) return
    const validationError = validateTaskAttachmentFile(file)
    if (validationError) {
      setError(t(validationError))
      return
    }
    setError(null)
    setUploading(true)
    try {
      await uploadTaskAttachment(tenantId, file, taskId)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tasks.errors.uploadFailed'))
    } finally {
      setUploading(false)
    }
  }

  async function handleOpen(attachment: CrmAttachment) {
    try {
      const url = await getAttachmentSignedUrl(attachment.storage_path)
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch {
      setError(t('tasks.errors.openAttachmentFailed'))
    }
  }

  return (
    <div>
      <Label>{t('tasks.attachments.label')}</Label>
      {attachments === null && <p className="text-xs text-brand-400">{t('common.status.loading')}</p>}
      {attachments && attachments.length === 0 && <p className="text-xs text-brand-400">{t('tasks.attachments.empty')}</p>}
      {attachments && attachments.length > 0 && (
        <ul className="space-y-1.5">
          {attachments.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => handleOpen(a)}
                className="flex w-full items-center gap-2.5 rounded-lg border border-brand-100 px-3 py-2 text-left hover:bg-brand-50"
              >
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-500">
                  {a.mime_type === 'application/pdf' ? <FileIcon width={15} height={15} /> : <ImageIcon width={15} height={15} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-brand-700">{a.original_filename ?? t('tasks.attachments.defaultName')}</span>
                  <span className="block text-xs text-brand-400">{formatFileSize(a.size_bytes)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,application/pdf" className="hidden" onChange={handleSelect} />
      <Button type="button" variant="ghost" onClick={() => inputRef.current?.click()} disabled={uploading} className="!mt-2 !px-3 !py-1.5 text-xs">
        <PaperclipIcon width={13} height={13} /> {uploading ? t('tasks.attachments.uploading') : t('tasks.attachments.attach')}
      </Button>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  )
}

export function TaskDrawer({
  open,
  onClose,
  tenantId,
  task,
  defaultOpportunityId,
  onSaved,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  /** Present when editing an existing task; omitted when creating a new one. */
  task?: TaskWithRelations | null
  /** Pre-links the task to an opportunity when created from OpportunityPanel's
   * "Tareas" tab -- ignored when editing (the task's own opportunity_id wins). */
  defaultOpportunityId?: string | null
  onSaved: () => void
}) {
  const { t } = useLanguage()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState<TaskPriority>('media')
  const [dueDate, setDueDate] = useState('')
  const [contactId, setContactId] = useState('')
  const [assignedTo, setAssignedTo] = useState('')
  const [contacts, setContacts] = useState<CrmContact[]>([])
  const [agents, setAgents] = useState<Profile[]>([])
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTitle(task?.title ?? '')
    setDescription(task?.description ?? '')
    setPriority(task?.priority ?? 'media')
    setDueDate(task?.due_date ? task.due_date.slice(0, 16) : '')
    setContactId(task?.contact_id ?? '')
    setAssignedTo(task?.assigned_to ?? '')
    setTouched(false)
    setFormError(null)
  }, [open, task])

  useEffect(() => {
    if (!open) return
    listContacts(tenantId).then(setContacts).catch(() => {})
    listProfilesByTenant(tenantId).then(setAgents).catch(() => {})
  }, [open, tenantId])

  const titleError = touched && !isNotBlank(title) ? t('tasks.field.titleRequired') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!isNotBlank(title)) return

    setSubmitting(true)
    try {
      const input = {
        tenant_id: tenantId,
        title: title.trim(),
        description: description.trim() || null,
        priority,
        due_date: dueDate ? new Date(dueDate).toISOString() : null,
        contact_id: contactId || null,
        assigned_to: assignedTo || null,
        ...(task ? {} : { opportunity_id: defaultOpportunityId ?? null }),
      }
      if (task) await updateTask(task.id, input)
      else await createTask(input)
      onSaved()
      onClose()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : t('tasks.errors.saveFailed'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title={task ? t('tasks.drawer.editTitle') : t('tasks.drawer.newTitle')} description={t('tasks.drawer.description')}>
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="task-title">{t('tasks.field.title')}</Label>
          <Input id="task-title" value={title} invalid={!!titleError} onChange={(e) => setTitle(e.target.value)} placeholder={t('tasks.field.titlePlaceholder')} />
          <FieldError message={titleError} />
        </div>

        <div>
          <Label htmlFor="task-description">{t('tasks.field.description')}</Label>
          <Textarea id="task-description" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <Label htmlFor="task-priority">{t('tasks.field.priority')}</Label>
            <Select id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              {(Object.keys(TASK_PRIORITY_KEY) as TaskPriority[]).map((p) => (
                <option key={p} value={p}>
                  {t(TASK_PRIORITY_KEY[p])}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="task-due">{t('tasks.field.dueDate')}</Label>
            <Input id="task-due" type="datetime-local" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </div>
        </div>

        <div>
          <Label htmlFor="task-contact">{t('tasks.field.contact')}</Label>
          <Select id="task-contact" value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">{t('tasks.field.noContact')}</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.full_name}
              </option>
            ))}
          </Select>
        </div>

        <div>
          <Label htmlFor="task-assigned">{t('tasks.field.assignedTo')}</Label>
          <Select id="task-assigned" value={assignedTo} onChange={(e) => setAssignedTo(e.target.value)}>
            <option value="">{t('tasks.field.unassigned')}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.full_name}
              </option>
            ))}
          </Select>
        </div>

        {task && <TaskAttachments tenantId={tenantId} taskId={task.id} />}

        {formError && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" variant="secondary" disabled={submitting}>
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
