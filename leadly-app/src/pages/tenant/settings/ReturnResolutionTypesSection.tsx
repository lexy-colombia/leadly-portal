import { useEffect, useState } from 'react'
import { createReturnResolutionType, listReturnResolutionTypes, updateReturnResolutionType } from '../../../lib/api/returnResolutionTypes'
import type { ReturnResolutionEffect, ReturnResolutionType } from '../../../types/domain'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { PageSpinner } from '@/components/atoms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PlusIcon } from '@/components/atoms/icons'

const FIELD_CLASS = '!h-7 !rounded-lg !text-xs'

const EFFECT_LABEL: Record<ReturnResolutionEffect, TranslationKey> = {
  saldo_a_favor: 'returns.effect.saldo_a_favor',
  reembolso_efectivo: 'returns.effect.reembolso_efectivo',
  cambio: 'returns.effect.cambio',
  ninguno: 'returns.effect.ninguno',
}

/** Sin reordenar ni eliminar a propósito -- a diferencia de
 * ReturnStatusesSection, acá "apagar" (is_active) es la única acción
 * destructiva, para no romper el historial de devoluciones que ya usaron
 * un tipo (returns.resolution_type_id es `on delete restrict`). */
export function ReturnResolutionTypesSection({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [types, setTypes] = useState<ReturnResolutionType[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  function reload() {
    listReturnResolutionTypes(tenantId)
      .then(setTypes)
      .catch((err) => setError(err instanceof Error ? err.message : t('returns.settings.resolutionTypes.errors.load')))
  }

  useEffect(reload, [tenantId])

  async function handleFieldSave(type: ReturnResolutionType, input: Partial<Pick<ReturnResolutionType, 'name' | 'effect' | 'is_active'>>) {
    setError(null)
    try {
      await updateReturnResolutionType(type.id, input)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('returns.settings.resolutionTypes.errors.save'))
    }
  }

  async function handleAdd() {
    setAdding(true)
    setError(null)
    try {
      await createReturnResolutionType(tenantId, { name: t('returns.settings.resolutionTypes.newName'), effect: 'ninguno', is_active: true })
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('returns.settings.resolutionTypes.errors.add'))
    } finally {
      setAdding(false)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-brand-400">{t('returns.settings.resolutionTypes.description')}</p>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {!types && !error && <PageSpinner />}

      {types && types.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-brand-100 bg-white">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('returns.settings.resolutionTypes.name')}</TableHead>
                <TableHead>{t('returns.settings.resolutionTypes.effect')}</TableHead>
                <TableHead>{t('returns.settings.resolutionTypes.active')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {types.map((type) => (
                <TableRow key={type.id}>
                  <TableCell>
                    <Input
                      defaultValue={type.name}
                      onBlur={(e) => e.target.value.trim() && e.target.value !== type.name && handleFieldSave(type, { name: e.target.value.trim() })}
                      className={`!w-48 ${FIELD_CLASS}`}
                    />
                  </TableCell>
                  <TableCell>
                    <Select defaultValue={type.effect} onValueChange={(v) => handleFieldSave(type, { effect: v as ReturnResolutionEffect })}>
                      <SelectTrigger className={`!w-56 ${FIELD_CLASS}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(EFFECT_LABEL) as ReturnResolutionEffect[]).map((effect) => (
                          <SelectItem key={effect} value={effect} className="text-xs">
                            {t(EFFECT_LABEL[effect])}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell>
                    <Switch checked={type.is_active} onCheckedChange={(checked) => handleFieldSave(type, { is_active: checked })} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Button type="button" variant="ghost" size="sm" onClick={handleAdd} disabled={adding}>
        <PlusIcon width={13} height={13} /> {adding ? t('returns.settings.resolutionTypes.adding') : t('returns.settings.resolutionTypes.add')}
      </Button>
    </div>
  )
}
