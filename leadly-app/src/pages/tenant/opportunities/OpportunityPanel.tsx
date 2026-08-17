import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { deleteOpportunity, type OpportunityWithRelations } from '../../../lib/api/opportunities'
import { listConversationsForContact, type ConversationWithLine } from '../../../lib/api/conversations'
import { listTasksForOpportunity, updateTask, type TaskWithRelations } from '../../../lib/api/tasks'
import { listOrdersForOpportunity, type OrderWithRelations } from '../../../lib/api/orders'
import type { OpportunityPriority, OrderStatus } from '../../../types/domain'
import { Badge, Button, PageSpinner } from '@/components/atoms'
import { Card, EmptyState } from '@/components/molecules'
import { ConfirmDialog, Drawer } from '@/components/organisms'
import { ChatBubbleIcon, CheckIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'
import { TaskDrawer } from '../tasks/TaskDrawer'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

const PRIORITY_LABEL: Record<OpportunityPriority, TranslationKey> = {
  baja: 'opportunities.priority.low',
  media: 'opportunities.priority.medium',
  alta: 'opportunities.priority.high',
}
const PRIORITY_TONE: Record<OpportunityPriority, 'neutral' | 'warning' | 'danger'> = { baja: 'neutral', media: 'warning', alta: 'danger' }
// Local key set (not shared with lib/api/orders.ts, which doesn't export one
// yet) -- same pattern as contacts.json's "contacts.order.status.*" keys.
const ORDER_STATUS_LABEL: Record<OrderStatus, TranslationKey> = {
  cotizacion: 'opportunities.order.status.cotizacion',
  confirmada: 'opportunities.order.status.confirmada',
  en_proceso: 'opportunities.order.status.en_proceso',
  entregada: 'opportunities.order.status.entregada',
  cancelada: 'opportunities.order.status.cancelada',
}
const ORDER_STATUS_TONE: Record<OrderStatus, 'neutral' | 'success' | 'warning' | 'danger'> = {
  cotizacion: 'neutral',
  confirmada: 'success',
  en_proceso: 'warning',
  entregada: 'success',
  cancelada: 'danger',
}

// Currency stays Colombian formatting regardless of UI language.
function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })
}

function formatDateTime(iso: string, locale: string): string {
  return new Date(iso).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Label-above-value field, same shape as ClientDetail's own `Field` --
 * duplicated locally rather than shared since it's a 6-line presentational
 * helper, not worth a cross-page import for. */
function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-brand-400">{label}</dt>
      <dd className="text-sm text-brand-700">{value}</dd>
    </div>
  )
}

export function OpportunityPanel({
  open,
  onClose,
  tenantId,
  pipelineName,
  opportunity,
  initialTab = 'resumen',
  onEdit,
  onChanged,
}: {
  open: boolean
  onClose: () => void
  tenantId: string
  pipelineName: string
  opportunity: OpportunityWithRelations | null
  /** Lets a caller jump straight to a tab -- e.g. the Kanban card's pending-task
   * badge opens straight into "tareas" instead of always landing on "resumen". */
  initialTab?: 'resumen' | 'conversaciones' | 'tareas'
  /** Opens the full edit form (OpportunityDrawer) -- the panel itself never
   * duplicates those editable fields. */
  onEdit: (opportunity: OpportunityWithRelations) => void
  /** Called after a delete so the Kanban/Lista reloads. */
  onChanged: () => void
}) {
  const navigate = useNavigate()
  const { t, language } = useLanguage()
  const locale = language === 'en' ? 'en-US' : 'es-CO'
  const [tab, setTab] = useState<'resumen' | 'conversaciones' | 'tareas'>('resumen')
  const [conversations, setConversations] = useState<ConversationWithLine[] | null>(null)
  const [tasks, setTasks] = useState<TaskWithRelations[] | null>(null)
  const [orders, setOrders] = useState<OrderWithRelations[] | null>(null)
  const [taskDrawer, setTaskDrawer] = useState<{ open: boolean; task: TaskWithRelations | null }>({ open: false, task: null })
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTab(initialTab)
    setConversations(null)
    setTasks(null)
    setOrders(null)
    setError(null)
  }, [open, opportunity?.id, initialTab])

  useEffect(() => {
    if (!open || !opportunity) return
    listOrdersForOpportunity(opportunity.id).then(setOrders).catch(() => setOrders([]))
  }, [open, opportunity])

  function reloadTasks() {
    if (!opportunity) return
    listTasksForOpportunity(opportunity.id).then(setTasks).catch(() => setTasks([]))
  }

  useEffect(() => {
    if (!open || !opportunity) return
    if (tab === 'conversaciones' && !conversations) {
      listConversationsForContact(opportunity.contact_id).then(setConversations).catch(() => setConversations([]))
    }
    if (tab === 'tareas' && !tasks) {
      reloadTasks()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tab, opportunity])

  async function handleToggleTask(task: TaskWithRelations) {
    setTasks((prev) => (prev ? prev.map((t) => (t.id === task.id ? { ...t, status: task.status === 'completada' ? 'pendiente' : 'completada' } : t)) : prev))
    try {
      await updateTask(task.id, { status: task.status === 'completada' ? 'pendiente' : 'completada' })
    } catch {
      reloadTasks()
    }
  }

  async function handleDelete() {
    if (!opportunity) return
    setDeleting(true)
    try {
      await deleteOpportunity(opportunity.id)
      setDeleteOpen(false)
      onChanged()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('opportunities.panel.errors.deleteFailed'))
      setDeleteOpen(false)
    } finally {
      setDeleting(false)
    }
  }

  if (!opportunity) return null

  const outcome = opportunity.stage?.is_won
    ? t('opportunities.panel.outcome.won')
    : opportunity.stage?.is_lost
      ? t('opportunities.panel.outcome.lost')
      : t('opportunities.panel.outcome.open')
  const outcomeTone = opportunity.stage?.is_won ? 'success' : opportunity.stage?.is_lost ? 'danger' : 'neutral'

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={opportunity.title}
        description={`${formatCurrency(opportunity.value, opportunity.currency)} · ${outcome}`}
        footer={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => onEdit(opportunity)} className="!py-1.5 text-xs">
              {t('common.actions.edit')}
            </Button>
            <Button variant="ghost" onClick={() => setDeleteOpen(true)} className="!py-1.5 text-xs">
              <TrashIcon width={13} height={13} /> {t('common.actions.delete')}
            </Button>
          </div>
        }
      >
        <div className="space-y-4">
          {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={outcomeTone}>{outcome}</Badge>
          </div>

          <div className="flex flex-wrap gap-1 border-b border-brand-100">
            {(
              [
                ['resumen', t('opportunities.panel.tabs.summary')],
                ['conversaciones', t('opportunities.panel.tabs.conversations')],
                ['tareas', t('opportunities.panel.tabs.tasks')],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setTab(value)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                  tab === value ? 'border-accent-500 text-accent-700' : 'border-transparent text-brand-400 hover:text-brand-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          {tab === 'resumen' && (
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-3">
                <Field label={t('opportunities.panel.fields.pipeline')} value={pipelineName} />
                <Field
                  label={t('opportunities.panel.fields.stage')}
                  value={opportunity.stage?.name ?? '—'}
                />
                <Field label={t('opportunities.panel.fields.owner')} value={opportunity.owner?.full_name ?? t('opportunities.panel.fields.unassigned')} />
                <Field label={t('opportunities.panel.fields.probability')} value={opportunity.stage ? `${opportunity.stage.probability}%` : '—'} />
                <Field label={t('opportunities.panel.fields.closeDate')} value={formatDate(opportunity.expected_close_date, locale)} />
                <Field label={t('opportunities.panel.fields.source')} value={opportunity.source ?? '—'} />
                <Field label={t('opportunities.panel.fields.createdAt')} value={formatDate(opportunity.created_at, locale)} />
                <div>
                  <dt className="text-xs text-brand-400">{t('opportunities.panel.fields.priority')}</dt>
                  <dd className="mt-0.5">
                    <Badge tone={PRIORITY_TONE[opportunity.priority]}>{t(PRIORITY_LABEL[opportunity.priority])}</Badge>
                  </dd>
                </div>
              </dl>

              {opportunity.description && (
                <div>
                  <p className="mb-1 text-xs text-brand-400">{t('opportunities.panel.fields.description')}</p>
                  <p className="whitespace-pre-wrap text-sm text-brand-700">{opportunity.description}</p>
                </div>
              )}

              <div className="border-t border-brand-100 pt-4">
                <p className="mb-2 text-xs text-brand-400">{t('opportunities.panel.orders.label')}</p>
                {orders === null && <PageSpinner />}
                {orders && orders.length === 0 && <p className="text-sm text-brand-400">{t('opportunities.panel.orders.empty')}</p>}
                {orders && orders.length > 0 && (
                  <ul className="space-y-1.5">
                    {orders.map((o) => (
                      <li key={o.id}>
                        <button
                          onClick={() => navigate(`/app/ventas/${o.id}`)}
                          className="flex w-full items-center justify-between gap-2 rounded-lg border border-brand-100 px-3 py-2 text-left text-sm transition-colors hover:bg-brand-50"
                        >
                          <span className="font-mono text-xs font-semibold text-brand-400">ORD-{o.number}</span>
                          <Badge tone={ORDER_STATUS_TONE[o.status]}>{t(ORDER_STATUS_LABEL[o.status])}</Badge>
                          <span className="ml-auto text-brand-700">{formatCurrency(o.total, o.currency)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {tab === 'conversaciones' && (
            <Card>
              {!conversations && <PageSpinner />}
              {conversations && conversations.length === 0 && <EmptyState>{t('opportunities.panel.conversations.empty')}</EmptyState>}
              {conversations && conversations.length > 0 && (
                <div className="space-y-2">
                  {conversations.map((conv) => (
                    <button
                      key={conv.id}
                      onClick={() => navigate(`/app?c=${conv.id}`)}
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-brand-100 px-4 py-3 text-left transition-colors hover:bg-brand-50"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-50 text-accent-600">
                          <ChatBubbleIcon width={14} height={14} />
                        </span>
                        <span className="min-w-0">
                          <span className="flex items-center gap-1.5">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${conv.mode === 'ia' ? 'bg-accent-500' : 'bg-amber-500'}`} />
                            <span className="text-sm font-medium text-brand-800">
                              {conv.mode === 'ia' ? t('opportunities.panel.conversations.modeIa') : t('opportunities.panel.conversations.modeHuman')}
                            </span>
                            {conv.status === 'closed' && <Badge tone="danger">{t('opportunities.panel.conversations.closed')}</Badge>}
                          </span>
                          <span className="block truncate text-xs text-brand-400">
                            {conv.whatsapp_line?.display_name ?? t('opportunities.panel.conversations.line')}
                          </span>
                        </span>
                      </span>
                      {conv.last_message_at && <span className="text-xs text-brand-300">{formatDateTime(conv.last_message_at, locale)}</span>}
                    </button>
                  ))}
                </div>
              )}
            </Card>
          )}

          {tab === 'tareas' && (
            <Card>
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm text-brand-400">
                  {tasks && tasks.length > 0
                    ? t('opportunities.panel.tasks.countLabel', {
                        done: tasks.filter((task) => task.status === 'completada').length,
                        total: tasks.length,
                      })
                    : t('opportunities.panel.tasks.subtitle')}
                </p>
                <Button variant="secondary" onClick={() => setTaskDrawer({ open: true, task: null })} className="!px-3 !py-1.5 text-xs">
                  <PlusIcon width={13} height={13} /> {t('opportunities.panel.tasks.new')}
                </Button>
              </div>
              {tasks && tasks.length > 0 && (
                <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-brand-100">
                  <div
                    className="h-full rounded-full bg-accent-500 transition-all"
                    style={{ width: `${Math.round((tasks.filter((task) => task.status === 'completada').length / tasks.length) * 100)}%` }}
                  />
                </div>
              )}
              {!tasks && <PageSpinner />}
              {tasks && tasks.length === 0 && <EmptyState>{t('opportunities.panel.tasks.empty')}</EmptyState>}
              {tasks && tasks.length > 0 && (
                <ul className="space-y-2">
                  {tasks.map((task) => (
                    <li key={task.id} className="flex items-start gap-2.5 rounded-xl border border-brand-100 px-3.5 py-2.5 hover:border-accent-200">
                      <button
                        type="button"
                        onClick={() => handleToggleTask(task)}
                        aria-label={
                          task.status === 'completada'
                            ? t('opportunities.panel.tasks.aria.markPending')
                            : t('opportunities.panel.tasks.aria.markDone')
                        }
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                          task.status === 'completada' ? 'border-accent-500 bg-accent-500 text-white' : 'border-brand-300 text-transparent hover:border-accent-400'
                        }`}
                      >
                        <CheckIcon width={11} height={11} />
                      </button>
                      <button type="button" onClick={() => setTaskDrawer({ open: true, task })} className="min-w-0 flex-1 text-left">
                        <p className={`text-sm ${task.status === 'completada' ? 'text-brand-400 line-through' : 'text-brand-800'}`}>{task.title}</p>
                        {task.due_date && <p className="text-xs text-brand-400">{formatDateTime(task.due_date, locale)}</p>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
        </div>
      </Drawer>

      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title={t('opportunities.panel.deleteConfirm.title')}
        description={t('opportunities.panel.deleteConfirm.description', { title: opportunity.title })}
        loading={deleting}
      />

      {opportunity && (
        <TaskDrawer
          open={taskDrawer.open}
          onClose={() => setTaskDrawer({ open: false, task: null })}
          tenantId={tenantId}
          task={taskDrawer.task}
          defaultOpportunityId={opportunity.id}
          onSaved={reloadTasks}
        />
      )}
    </>
  )
}
