import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { Language, TranslationKey } from '../../i18n/translations'
import { deleteTask, listTasks, TASK_PRIORITY_KEY, updateTask } from '../../lib/api/tasks'
import type { TaskWithRelations } from '../../lib/api/tasks'
import type { TaskPriority, TaskStatus } from '../../types/domain'
import { Badge, Button, Card, EmptyState, PageSpinner, Pagination, Select, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'
import { CheckIcon, PencilIcon, PlusIcon, TrashIcon } from '../../components/icons'
import { TaskDrawer } from './tasks/TaskDrawer'

const PAGE_SIZE = 10
const PRIORITY_TONE: Record<TaskPriority, 'neutral' | 'warning' | 'danger'> = { baja: 'neutral', media: 'warning', alta: 'danger' }
const STATUS_KEY: Record<TaskStatus, TranslationKey> = {
  pendiente: 'tasks.status.pendiente',
  en_proceso: 'tasks.status.en_proceso',
  completada: 'tasks.status.completada',
  cancelada: 'tasks.status.cancelada',
}

function formatDueDate(iso: string | null, language: Language, t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  if (!iso) return t('tasks.dueDate.none')
  const date = new Date(iso)
  const overdue = date.getTime() < Date.now()
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  const text = date.toLocaleDateString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  return overdue ? t('tasks.dueDate.overdueSuffix', { date: text }) : text
}

export function Tareas() {
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const [tasks, setTasks] = useState<TaskWithRelations[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<TaskStatus | ''>('')
  const [page, setPage] = useState(1)
  const [drawer, setDrawer] = useState<{ open: boolean; task: TaskWithRelations | null }>({ open: false, task: null })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [togglingId, setTogglingId] = useState<string | null>(null)

  function reload() {
    if (!profile?.tenant_id) return
    listTasks(profile.tenant_id)
      .then(setTasks)
      .catch((err) => setError(err.message ?? t('tasks.errors.loadFailed')))
  }

  useEffect(reload, [profile?.tenant_id])

  const filtered = useMemo(() => {
    if (!tasks) return null
    if (!statusFilter) return tasks
    return tasks.filter((t) => t.status === statusFilter)
  }, [tasks, statusFilter])

  useEffect(() => {
    setPage(1)
  }, [statusFilter])

  const totalPages = filtered ? Math.max(1, Math.ceil(filtered.length / PAGE_SIZE)) : 1
  const pageItems = filtered ? filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  async function handleToggleComplete(task: TaskWithRelations) {
    setTogglingId(task.id)
    setError(null)
    try {
      await updateTask(task.id, { status: task.status === 'completada' ? 'pendiente' : 'completada' })
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tasks.errors.updateFailed'))
    } finally {
      setTogglingId(null)
    }
  }

  async function handleDelete(id: string) {
    setDeleting(true)
    setError(null)
    try {
      await deleteTask(id)
      setTasks((prev) => (prev ? prev.filter((t) => t.id !== id) : prev))
      setDeletingId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : t('tasks.errors.deleteFailed'))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TaskStatus | '')} className="!w-auto !py-1 text-xs">
          <option value="">{t('tasks.filter.all')}</option>
          {(Object.keys(STATUS_KEY) as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {t(STATUS_KEY[s])}
            </option>
          ))}
        </Select>

        <span className="shrink-0 text-xs text-brand-400">
          {t((filtered?.length ?? 0) === 1 ? 'tasks.count.singular' : 'tasks.count.plural', { count: filtered?.length ?? 0 })}
        </span>

        <Button variant="secondary" onClick={() => setDrawer({ open: true, task: null })} className="!ml-auto !py-1 !text-xs">
          <PlusIcon width={14} height={14} /> {t('tasks.actions.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!tasks && !error && <PageSpinner />}

      {filtered && filtered.length === 0 && (
        <Card>
          <EmptyState>{tasks && tasks.length > 0 ? t('tasks.empty.noneInStatus') : t('tasks.empty.noTasks')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
        <Table>
          <THead>
            <tr>
              <TH></TH>
              <TH>{t('tasks.table.task')}</TH>
              <TH>{t('tasks.table.priority')}</TH>
              <TH>{t('tasks.table.due')}</TH>
              <TH>{t('tasks.table.assignedTo')}</TH>
              <TH className="text-right">{t('tasks.table.actions')}</TH>
            </tr>
          </THead>
          <TBody>
            {pageItems.map((task) => {
              const done = task.status === 'completada'
              return (
                <TRow key={task.id}>
                  <TD>
                    <button
                      type="button"
                      onClick={() => handleToggleComplete(task)}
                      disabled={togglingId === task.id}
                      aria-label={done ? t('tasks.aria.markPending') : t('tasks.aria.markCompleted')}
                      className={`flex h-5 w-5 items-center justify-center rounded-full border transition-colors ${
                        done ? 'border-accent-500 bg-accent-500 text-white' : 'border-brand-300 text-transparent hover:border-accent-400'
                      }`}
                    >
                      <CheckIcon width={12} height={12} />
                    </button>
                  </TD>
                  <TD className={`text-xs font-medium ${done ? 'text-brand-400 line-through' : 'text-brand-800'}`}>
                    {task.title}
                    {task.opportunity && <span className="block text-[11px] font-normal text-brand-400">{task.opportunity.title}</span>}
                    {task.contact && !task.opportunity && <span className="block text-[11px] font-normal text-brand-400">{task.contact.full_name}</span>}
                  </TD>
                  <TD>
                    <Badge tone={PRIORITY_TONE[task.priority]}>{t(TASK_PRIORITY_KEY[task.priority])}</Badge>
                  </TD>
                  <TD className="text-xs text-brand-500">{formatDueDate(task.due_date, language, t)}</TD>
                  <TD className="text-xs text-brand-500">{task.assignee?.full_name ?? '-'}</TD>
                  <TD className="text-right">
                    {deletingId === task.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="danger" onClick={() => handleDelete(task.id)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {deleting ? t('common.actions.deleting') : t('common.actions.confirm')}
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {t('common.actions.cancel')}
                        </Button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Button variant="ghost" onClick={() => setDrawer({ open: true, task })} className="!px-2 !py-1 text-xs">
                          <PencilIcon width={12} height={12} />
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(task.id)} className="!px-2 !py-1 text-xs !text-red-600 hover:!bg-red-50">
                          <TrashIcon width={12} height={12} />
                        </Button>
                      </span>
                    )}
                  </TD>
                </TRow>
              )
            })}
          </TBody>
        </Table>
        <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      {profile?.tenant_id && (
        <TaskDrawer open={drawer.open} onClose={() => setDrawer({ open: false, task: null })} tenantId={profile.tenant_id} task={drawer.task} onSaved={reload} />
      )}
    </div>
  )
}
