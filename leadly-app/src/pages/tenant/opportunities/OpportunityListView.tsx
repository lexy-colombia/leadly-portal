import type { OpportunityWithRelations } from '../../../lib/api/opportunities'
import type { PipelineStage, OpportunityPriority } from '../../../types/domain'
import { EmptyState } from '@/components/molecules'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'
import { formatDate } from '../../../lib/dates'

const PRIORITY_BADGE_CLASS: Record<OpportunityPriority, string> = {
  baja: 'border-transparent bg-slate-100 text-slate-600',
  media: 'border-transparent bg-amber-100 text-amber-700',
  alta: 'border-transparent bg-red-100 text-red-700',
}
const PRIORITY_LABEL: Record<OpportunityPriority, TranslationKey> = {
  baja: 'opportunities.priority.low',
  media: 'opportunities.priority.medium',
  alta: 'opportunities.priority.high',
}

// Currency stays Colombian formatting regardless of UI language.
function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

/** "Lista" alternative to the Kanban -- same filtered/sorted opportunities,
 * flat table instead of columns-by-stage. Moving stage here is a plain
 * select per row (same as the pre-Kanban Opportunities.tsx used to work)
 * instead of drag-and-drop, since there's nothing to drop a row onto. */
export function OpportunityListView({
  opportunities,
  stages,
  onOpen,
  onStageChange,
}: {
  opportunities: OpportunityWithRelations[]
  stages: PipelineStage[]
  onOpen: (opportunity: OpportunityWithRelations) => void
  onStageChange: (opportunity: OpportunityWithRelations, stage: PipelineStage) => void
}) {
  const { t } = useLanguage()

  if (opportunities.length === 0) {
    return <EmptyState>{t('opportunities.list.empty')}</EmptyState>
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('opportunities.list.columns.title')}</TableHead>
            <TableHead>{t('opportunities.list.columns.contact')}</TableHead>
            <TableHead>{t('opportunities.list.columns.stage')}</TableHead>
            <TableHead>{t('opportunities.list.columns.value')}</TableHead>
            <TableHead>{t('opportunities.list.columns.priority')}</TableHead>
            <TableHead>{t('opportunities.list.columns.owner')}</TableHead>
            <TableHead>{t('opportunities.list.columns.closeDate')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {opportunities.map((opp) => (
            <TableRow key={opp.id} className="cursor-pointer" onClick={() => onOpen(opp)}>
              <TableCell className="text-xs font-medium text-brand-800">{opp.title}</TableCell>
              <TableCell className="text-xs text-brand-700">{opp.contact?.full_name ?? '—'}</TableCell>
              <TableCell onClick={(e) => e.stopPropagation()}>
                <Select
                  value={opp.stage_id}
                  onValueChange={(v) => {
                    const stage = stages.find((s) => s.id === v)
                    if (stage) onStageChange(opp, stage)
                  }}
                >
                  <SelectTrigger className="!h-7 w-auto !rounded-lg !text-xs">
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
              </TableCell>
              <TableCell className="text-xs text-brand-700">{formatCurrency(opp.value, opp.currency)}</TableCell>
              <TableCell>
                <Badge variant="outline" className={PRIORITY_BADGE_CLASS[opp.priority]}>
                  {t(PRIORITY_LABEL[opp.priority])}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-brand-500">{opp.owner?.full_name ?? t('opportunities.list.unassigned')}</TableCell>
              <TableCell className="text-xs text-brand-500">{formatDate(opp.expected_close_date)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
