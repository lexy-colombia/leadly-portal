import type { OpportunityWithRelations } from '../../../lib/api/opportunities'
import type { CrmPipelineStage, OpportunityPriority } from '../../../types/domain'
import { Badge, EmptyState, Select, TBody, TD, TH, THead, Table, TRow } from '../../../components/ui'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

const PRIORITY_TONE: Record<OpportunityPriority, 'neutral' | 'warning' | 'danger'> = { baja: 'neutral', media: 'warning', alta: 'danger' }
const PRIORITY_LABEL: Record<OpportunityPriority, TranslationKey> = {
  baja: 'opportunities.priority.low',
  media: 'opportunities.priority.medium',
  alta: 'opportunities.priority.high',
}

// Currency stays Colombian formatting regardless of UI language.
function formatCurrency(value: number, currency = 'COP'): string {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency, maximumFractionDigits: 0 }).format(value)
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(locale, { day: '2-digit', month: 'short', year: 'numeric' })
}

/** "Lista" alternative to the Kanban -- same filtered/sorted opportunities,
 * flat table instead of columns-by-stage. Moving stage here is a plain
 * select per row (same as the pre-Kanban Oportunidades.tsx used to work)
 * instead of drag-and-drop, since there's nothing to drop a row onto. */
export function OpportunityListView({
  opportunities,
  stages,
  onOpen,
  onStageChange,
}: {
  opportunities: OpportunityWithRelations[]
  stages: CrmPipelineStage[]
  onOpen: (opportunity: OpportunityWithRelations) => void
  onStageChange: (opportunity: OpportunityWithRelations, stage: CrmPipelineStage) => void
}) {
  const { t, language } = useLanguage()
  const locale = language === 'en' ? 'en-US' : 'es-CO'

  if (opportunities.length === 0) {
    return <EmptyState>{t('opportunities.list.empty')}</EmptyState>
  }

  return (
    <Table>
      <THead>
        <tr>
          <TH>{t('opportunities.list.columns.title')}</TH>
          <TH>{t('opportunities.list.columns.contact')}</TH>
          <TH>{t('opportunities.list.columns.stage')}</TH>
          <TH>{t('opportunities.list.columns.value')}</TH>
          <TH>{t('opportunities.list.columns.priority')}</TH>
          <TH>{t('opportunities.list.columns.owner')}</TH>
          <TH>{t('opportunities.list.columns.closeDate')}</TH>
        </tr>
      </THead>
      <TBody>
        {opportunities.map((opp) => (
          <TRow key={opp.id} clickable onClick={() => onOpen(opp)}>
            <TD className="font-medium text-brand-800">{opp.title}</TD>
            <TD>{opp.contact?.full_name ?? '—'}</TD>
            <TD onClick={(e) => e.stopPropagation()}>
              <Select
                value={opp.stage_id}
                onChange={(e) => {
                  const stage = stages.find((s) => s.id === e.target.value)
                  if (stage) onStageChange(opp, stage)
                }}
                className="!w-auto !py-1.5 text-xs"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </TD>
            <TD>{formatCurrency(opp.value, opp.currency)}</TD>
            <TD>
              <Badge tone={PRIORITY_TONE[opp.priority]}>{t(PRIORITY_LABEL[opp.priority])}</Badge>
            </TD>
            <TD>{opp.owner?.full_name ?? t('opportunities.list.unassigned')}</TD>
            <TD>{formatDate(opp.expected_close_date, locale)}</TD>
          </TRow>
        ))}
      </TBody>
    </Table>
  )
}
