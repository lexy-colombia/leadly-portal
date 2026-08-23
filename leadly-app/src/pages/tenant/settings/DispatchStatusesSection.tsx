import { useEffect, useState } from 'react'
import {
  createDispatchStatus,
  deleteDispatchStatus,
  listDispatchStatuses,
  reorderDispatchStatuses,
  updateDispatchStatus,
  type DispatchStatusInput,
} from '../../../lib/api/dispatchStatuses'
import type { DispatchStatus, DispatchStockEffect } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { PageSpinner } from '@/components/atoms'
import { ConfirmDialog } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ChevronLeftIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

const STOCK_EFFECT_LABEL: Record<DispatchStockEffect, TranslationKey> = {
  none: 'dispatches.settings.stockEffect.none',
  reserve: 'dispatches.settings.stockEffect.reserve',
  ship: 'dispatches.settings.stockEffect.ship',
  deliver: 'dispatches.settings.stockEffect.deliver',
}

function resolveError(err: unknown, t: (key: TranslationKey) => string, fallback: TranslationKey): string {
  return err instanceof Error ? t(err.message as TranslationKey) : t(fallback)
}

export function DispatchStatusesSection({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [statuses, setStatuses] = useState<DispatchStatus[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [statusToDelete, setStatusToDelete] = useState<DispatchStatus | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    listDispatchStatuses(tenantId)
      .then(setStatuses)
      .catch((err) => setError(err instanceof Error ? err.message : t('dispatches.settings.errors.load')))
  }

  useEffect(reload, [tenantId])

  async function handleFieldSave(status: DispatchStatus, input: Partial<DispatchStatusInput>) {
    setError(null)
    try {
      await updateDispatchStatus(status.id, input)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dispatches.settings.errors.save'))
    }
  }

  async function handleAdd() {
    setAdding(true)
    setError(null)
    try {
      await createDispatchStatus(tenantId, {
        name: t('dispatches.settings.newStatusName'),
        color: '#94A3B8',
        stock_effect: 'none',
        is_terminal: false,
      })
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dispatches.settings.errors.add'))
    } finally {
      setAdding(false)
    }
  }

  async function handleMove(index: number, direction: -1 | 1) {
    if (!statuses) return
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= statuses.length) return
    const reordered = [...statuses]
    ;[reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]]
    setStatuses(reordered)
    setError(null)
    try {
      await reorderDispatchStatuses(reordered.map((s) => s.id))
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('dispatches.settings.errors.reorder'))
      reload()
    }
  }

  async function handleConfirmDelete() {
    if (!statusToDelete) return
    setDeleting(true)
    try {
      await deleteDispatchStatus(tenantId, statusToDelete.id)
      setStatusToDelete(null)
      reload()
    } catch (err) {
      setError(resolveError(err, t, 'dispatches.settings.errors.delete'))
      setStatusToDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-brand-400">{t('dispatches.settings.description')}</p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!statuses && !error && <PageSpinner />}

      {statuses && statuses.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-brand-100 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>{t('dispatches.settings.status.name')}</TableHead>
                <TableHead>{t('dispatches.settings.status.stockEffect')}</TableHead>
                <TableHead>{t('dispatches.settings.status.terminal')}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {statuses.map((status, index) => (
                <TableRow key={status.id}>
                  <TableCell>
                    <div className="flex flex-col items-center">
                      <button
                        type="button"
                        onClick={() => handleMove(index, -1)}
                        disabled={index === 0}
                        aria-label={t('dispatches.settings.status.moveUpAria')}
                        className="text-brand-400 hover:text-brand-700 disabled:opacity-30"
                      >
                        <ChevronLeftIcon width={12} height={12} className="rotate-90" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(index, 1)}
                        disabled={index === statuses.length - 1}
                        aria-label={t('dispatches.settings.status.moveDownAria')}
                        className="text-brand-400 hover:text-brand-700 disabled:opacity-30"
                      >
                        <ChevronLeftIcon width={12} height={12} className="-rotate-90" />
                      </button>
                    </div>
                  </TableCell>

                  <TableCell>
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-input p-0.5">
                        <input
                          type="color"
                          defaultValue={status.color}
                          aria-label={t('dispatches.settings.status.color')}
                          onBlur={(e) => e.target.value !== status.color && handleFieldSave(status, { color: e.target.value })}
                          className="h-full w-full cursor-pointer border-0 bg-transparent p-0"
                        />
                      </span>
                      <Input
                        defaultValue={status.name}
                        onBlur={(e) => e.target.value.trim() && e.target.value !== status.name && handleFieldSave(status, { name: e.target.value.trim() })}
                        className={`!w-32 ${FIELD_CLASS}`}
                      />
                    </div>
                  </TableCell>

                  <TableCell>
                    <Select defaultValue={status.stock_effect} onValueChange={(v) => handleFieldSave(status, { stock_effect: v as DispatchStockEffect })}>
                      <SelectTrigger className={`!w-64 ${FIELD_CLASS}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(STOCK_EFFECT_LABEL) as DispatchStockEffect[]).map((effect) => (
                          <SelectItem key={effect} value={effect} className="text-xs">
                            {t(STOCK_EFFECT_LABEL[effect])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>

                  <TableCell>
                    <Switch checked={status.is_terminal} onCheckedChange={(checked) => handleFieldSave(status, { is_terminal: checked })} />
                  </TableCell>

                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setStatusToDelete(status)}
                      aria-label={t('dispatches.settings.status.deleteAria', { name: status.name })}
                      className="text-brand-400 hover:bg-red-50 hover:text-red-600"
                    >
                      <TrashIcon width={14} height={14} />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Button type="button" variant="ghost" size="sm" onClick={handleAdd} disabled={adding}>
        <PlusIcon width={13} height={13} /> {adding ? t('dispatches.settings.status.adding') : t('dispatches.settings.status.add')}
      </Button>

      <ConfirmDialog
        open={!!statusToDelete}
        onClose={() => setStatusToDelete(null)}
        onConfirm={handleConfirmDelete}
        title={t('dispatches.settings.deleteStatusConfirm.title')}
        description={t('dispatches.settings.deleteStatusConfirm.description', { name: statusToDelete?.name ?? '' })}
        loading={deleting}
      />
    </div>
  )
}
