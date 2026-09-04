import { useState } from 'react'
import { useLanguage } from '../../../contexts/LanguageContext'
import { Card, CardSection } from '@/components/molecules'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ReturnStatusesSection } from './ReturnStatusesSection'
import { ReturnResolutionTypesSection } from './ReturnResolutionTypesSection'

/** "Devoluciones" category -- two internal tabs (Estados / Tipos de
 * resolución) so both tables are never shown at once, same catalogs and
 * business rules as before (nothing about how a status or a resolution
 * type behaves changed, only that they're now tabs of one panel instead of
 * two stacked cards). */
export function ReturnsSection({ tenantId }: { tenantId: string }) {
  const { t } = useLanguage()
  const [tab, setTab] = useState<'statuses' | 'resolutionTypes'>('statuses')

  return (
    <Card padded={false}>
      <CardSection title={t('settings.returns.title')} description={t('settings.returns.description')}>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="statuses">{t('returns.settings.statuses.title')}</TabsTrigger>
            <TabsTrigger value="resolutionTypes">{t('returns.settings.resolutionTypes.title')}</TabsTrigger>
          </TabsList>
          <TabsContent value="statuses" className="pt-4">
            <ReturnStatusesSection tenantId={tenantId} />
          </TabsContent>
          <TabsContent value="resolutionTypes" className="pt-4">
            <ReturnResolutionTypesSection tenantId={tenantId} />
          </TabsContent>
        </Tabs>
      </CardSection>
    </Card>
  )
}
