import { useEffect, useState } from 'react'
import { createPosPoint, deletePosPoint, listPosPoints, reorderPosPoints, updatePosPoint, type PosPointInput } from '../../../lib/api/posPoints'
import type { PosPoint } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import { PageSpinner, Switch } from '@/components/atoms'
import { ConfirmDialog } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ChevronLeftIcon, PlusIcon, TrashIcon } from '@/components/atoms/icons'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'
const KIND_OPTIONS: PosPointInput['kind'][] = ['mesa', 'caja', 'punto']

/** Catálogo opcional de mesas/cajas del POS -- calco estructural de
 * DispatchStatusesSection.tsx (tabla editable inline + flechas), con dos
 * diferencias: `kind` en vez de color/terminal, y sin guard de "no borrar
 * el último" al eliminar (soft-delete, cero puntos es un estado válido).
 *
 * Lista los puntos activos e inactivos por igual -- es el único lugar desde
 * donde se reactiva uno; el módulo POS solo ve los activos. */
export function PosPointsSection({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [points, setPoints] = useState<PosPoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [pointToDelete, setPointToDelete] = useState<PosPoint | null>(null)
  const [deleting, setDeleting] = useState(false)

  function reload() {
    listPosPoints(tenantId)
      .then(setPoints)
      .catch((err) => setError(err instanceof Error ? err.message : t('settings.pos.points.errors.load')))
  }

  useEffect(reload, [tenantId])

  async function handleFieldSave(point: PosPoint, input: Partial<PosPointInput & { is_active: boolean }>) {
    setError(null)
    try {
      await updatePosPoint(point.id, input)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.pos.points.errors.save'))
    }
  }

  async function handleAdd() {
    setAdding(true)
    setError(null)
    try {
      await createPosPoint(tenantId, { name: t('settings.pos.points.newPointName'), kind: 'punto' })
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.pos.points.errors.add'))
    } finally {
      setAdding(false)
    }
  }

  async function handleMove(index: number, direction: -1 | 1) {
    if (!points) return
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= points.length) return
    const reordered = [...points]
    ;[reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]]
    setPoints(reordered)
    setError(null)
    try {
      await reorderPosPoints(reordered.map((p) => p.id))
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.pos.points.errors.reorder'))
      reload()
    }
  }

  async function handleConfirmDelete() {
    if (!pointToDelete) return
    setDeleting(true)
    try {
      await deletePosPoint(pointToDelete.id)
      setPointToDelete(null)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('settings.pos.points.errors.delete'))
      setPointToDelete(null)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-brand-400">{t('settings.pos.points.description')}</p>
      <p className="text-xs text-brand-400">{t('settings.pos.points.activeHint')}</p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!points && !error && <PageSpinner />}

      {points && points.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-brand-100 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10" />
                <TableHead>{t('settings.pos.points.name')}</TableHead>
                <TableHead>{t('settings.pos.points.kind')}</TableHead>
                <TableHead>{t('settings.pos.points.active')}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {points.map((point, index) => (
                <TableRow key={point.id}>
                  <TableCell>
                    <div className="flex flex-col items-center">
                      <button
                        type="button"
                        onClick={() => handleMove(index, -1)}
                        disabled={index === 0}
                        aria-label={t('settings.pos.points.moveUpAria')}
                        className="text-brand-400 hover:text-brand-700 disabled:opacity-30"
                      >
                        <ChevronLeftIcon width={12} height={12} className="rotate-90" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleMove(index, 1)}
                        disabled={index === points.length - 1}
                        aria-label={t('settings.pos.points.moveDownAria')}
                        className="text-brand-400 hover:text-brand-700 disabled:opacity-30"
                      >
                        <ChevronLeftIcon width={12} height={12} className="-rotate-90" />
                      </button>
                    </div>
                  </TableCell>

                  <TableCell>
                    <Input
                      defaultValue={point.name}
                      onBlur={(e) => e.target.value.trim() && e.target.value !== point.name && handleFieldSave(point, { name: e.target.value.trim() })}
                      className={`!w-32 ${FIELD_CLASS}`}
                    />
                  </TableCell>

                  <TableCell>
                    <Select value={point.kind} onValueChange={(v) => handleFieldSave(point, { kind: v as PosPointInput['kind'] })}>
                      <SelectTrigger className={`!w-28 ${FIELD_CLASS}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KIND_OPTIONS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {t(`settings.pos.points.kindOptions.${k}` as never)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>

                  <TableCell>
                    <Switch checked={point.is_active} onChange={(is_active) => handleFieldSave(point, { is_active })} />
                  </TableCell>

                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => setPointToDelete(point)}
                      aria-label={t('settings.pos.points.deleteAria', { name: point.name })}
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
        <PlusIcon width={13} height={13} /> {adding ? t('settings.pos.points.adding') : t('settings.pos.points.add')}
      </Button>

      <ConfirmDialog
        open={!!pointToDelete}
        onClose={() => setPointToDelete(null)}
        onConfirm={handleConfirmDelete}
        title={t('settings.pos.points.deleteConfirm.title')}
        description={t('settings.pos.points.deleteConfirm.description', { name: pointToDelete?.name ?? '' })}
        loading={deleting}
      />
    </div>
  )
}
