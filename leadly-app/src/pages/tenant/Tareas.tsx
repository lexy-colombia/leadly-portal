import { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { deleteTask, listTasks, updateTask } from '../../lib/api/tasks'
import type { TaskWithRelations } from '../../lib/api/tasks'
import type { TaskPriority, TaskStatus } from '../../types/domain'
import { Badge, Button, Card, EmptyState, PageSpinner, Pagination, Select, Table, TBody, TD, TH, THead, TRow } from '../../components/ui'
import { CheckIcon, PencilIcon, PlusIcon, TrashIcon } from '../../components/icons'
import { TaskDrawer } from './tasks/TaskDrawer'

const PAGE_SIZE = 10
const PRIORITY_TONE: Record<TaskPriority, 'neutral' | 'warning' | 'danger'> = { baja: 'neutral', media: 'warning', alta: 'danger' }
const STATUS_LABEL: Record<TaskStatus, string> = { pendiente: 'Pendiente', en_proceso: 'En proceso', completada: 'Completada', cancelada: 'Cancelada' }

function formatDueDate(iso: string | null): string {
  if (!iso) return 'Sin fecha'
  const date = new Date(iso)
  const overdue = date.getTime() < Date.now()
  const text = date.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  return overdue ? `${text} (vencida)` : text
}

export function Tareas() {
  const { profile } = useAuth()
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
      .catch((err) => setError(err.message ?? 'No se pudieron cargar las tareas.'))
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
      setError(err instanceof Error ? err.message : 'No se pudo actualizar la tarea.')
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
      setError(err instanceof Error ? err.message : 'No se pudo eliminar la tarea.')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as TaskStatus | '')} className="!w-auto !py-1 text-xs">
          <option value="">Todas</option>
          {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </Select>

        <span className="shrink-0 text-xs text-brand-400">
          {filtered?.length ?? 0} {(filtered?.length ?? 0) === 1 ? 'tarea' : 'tareas'}
        </span>

        <Button variant="secondary" onClick={() => setDrawer({ open: true, task: null })} className="!ml-auto !py-1 !text-xs">
          <PlusIcon width={14} height={14} /> Nueva tarea
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!tasks && !error && <PageSpinner />}

      {filtered && filtered.length === 0 && (
        <Card>
          <EmptyState>{tasks && tasks.length > 0 ? 'Ninguna tarea en este estado.' : 'Todavía no tenés tareas registradas.'}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
        <Table>
          <THead>
            <tr>
              <TH></TH>
              <TH>Tarea</TH>
              <TH>Prioridad</TH>
              <TH>Vence</TH>
              <TH>Asignada a</TH>
              <TH className="text-right">Acciones</TH>
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
                      aria-label={done ? 'Marcar como pendiente' : 'Marcar como completada'}
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
                    <Badge tone={PRIORITY_TONE[task.priority]}>{task.priority}</Badge>
                  </TD>
                  <TD className="text-xs text-brand-500">{formatDueDate(task.due_date)}</TD>
                  <TD className="text-xs text-brand-500">{task.assignee?.full_name ?? '-'}</TD>
                  <TD className="text-right">
                    {deletingId === task.id ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Button variant="danger" onClick={() => handleDelete(task.id)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          {deleting ? 'Eliminando…' : 'Confirmar'}
                        </Button>
                        <Button variant="ghost" onClick={() => setDeletingId(null)} disabled={deleting} className="!px-2 !py-1 text-xs">
                          Cancelar
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
