import { useEffect, useState } from 'react'
import { cancelCampaign, getCampaign, listCampaignRecipients } from '../../../lib/api/campaigns'
import type { CampaignWithRelations } from '../../../lib/api/campaigns'
import type { CampaignRecipient, CampaignRecipientStatus } from '../../../types/domain'
import type { TranslationKey } from '../../../i18n/translations'
import { PageSpinner } from '@/components/atoms'
import { Pagination } from '@/components/molecules'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useLanguage } from '../../../contexts/LanguageContext'
import { CAMPAIGN_STATUS_BADGE_CLASS, CAMPAIGN_STATUS_KEY } from '../Campaigns'

const PAGE_SIZE = 10

const RECIPIENT_STATUS_KEY: Record<CampaignRecipientStatus, TranslationKey> = {
  pending: 'campaigns.recipientStatus.pending',
  sent: 'campaigns.recipientStatus.sent',
  failed: 'campaigns.recipientStatus.failed',
}

const RECIPIENT_STATUS_BADGE_CLASS: Record<CampaignRecipientStatus, string> = {
  pending: 'border-transparent bg-slate-100 text-slate-600',
  sent: 'border-transparent bg-emerald-100 text-emerald-700',
  failed: 'border-transparent bg-red-100 text-red-700',
}

export function CampaignDetailDrawer({
  campaignId,
  onClose,
  onChanged,
}: {
  campaignId: string | null
  onClose: () => void
  onChanged: () => void
}) {
  const { t, language } = useLanguage()
  const [campaign, setCampaign] = useState<CampaignWithRelations | null>(null)
  const [recipients, setRecipients] = useState<CampaignRecipient[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [canceling, setCanceling] = useState(false)

  function reload() {
    if (!campaignId) return
    getCampaign(campaignId).then(setCampaign).catch((err) => setError(err.message ?? t('campaigns.errors.load')))
    listCampaignRecipients(campaignId).then(setRecipients).catch(() => setRecipients([]))
  }

  useEffect(() => {
    setCampaign(null)
    setRecipients(null)
    setError(null)
    setPage(1)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campaignId])

  async function handleCancel() {
    if (!campaignId) return
    setCanceling(true)
    try {
      await cancelCampaign(campaignId)
      reload()
      onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : t('campaigns.errors.cancelFailed'))
    } finally {
      setCanceling(false)
    }
  }

  const totalPages = recipients ? Math.max(1, Math.ceil(recipients.length / PAGE_SIZE)) : 1
  const pageItems = recipients ? recipients.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null
  const locale = language === 'en' ? 'en-US' : 'es-CO'

  return (
    <Drawer open={!!campaignId} onClose={onClose} title={campaign?.name ?? t('campaigns.detail.title')} description={campaign?.template?.name}>
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!campaign && !error && <PageSpinner />}

      {campaign && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-brand-100 p-3 text-xs">
            <div>
              <p className="text-brand-400">{t('campaigns.table.status')}</p>
              <Badge variant="outline" className={`mt-1 ${CAMPAIGN_STATUS_BADGE_CLASS[campaign.status]}`}>
                {t(CAMPAIGN_STATUS_KEY[campaign.status])}
              </Badge>
            </div>
            <div>
              <p className="text-brand-400">{t('campaigns.table.scheduledAt')}</p>
              <p className="mt-1 font-medium text-brand-700">
                {new Date(campaign.scheduled_at).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
            <div>
              <p className="text-brand-400">{t('campaigns.table.line')}</p>
              <p className="mt-1 font-medium text-brand-700">{campaign.whatsapp_line?.display_name ?? '-'}</p>
            </div>
            <div>
              <p className="text-brand-400">{t('campaigns.detail.progress')}</p>
              <p className="mt-1 font-medium text-brand-700">
                {campaign.sent_count} {t('campaigns.detail.sent')} · {campaign.failed_count} {t('campaigns.detail.failed')} / {campaign.total_recipients}
              </p>
            </div>
            {campaign.topic && (
              <div className="col-span-2">
                <p className="text-brand-400">{t('campaigns.newDrawer.topicLabel')}</p>
                <p className="mt-1 text-brand-600">{campaign.topic}</p>
              </div>
            )}
          </div>

          {campaign.status === 'scheduled' && (
            <Button variant="outline" size="sm" onClick={handleCancel} disabled={canceling}>
              {canceling ? t('common.actions.saving') : t('campaigns.detail.cancelCampaign')}
            </Button>
          )}

          {!recipients && <PageSpinner />}
          {pageItems && pageItems.length > 0 && (
            <>
              <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t('campaigns.detail.recipient')}</TableHead>
                      <TableHead>{t('campaigns.table.status')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageItems.map((recipient) => (
                      <TableRow key={recipient.id}>
                        <TableCell className="text-xs">
                          <span className="block font-medium text-brand-800">{recipient.contact_name || recipient.contact_phone}</span>
                          <span className="block text-brand-400">{recipient.contact_phone}</span>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={RECIPIENT_STATUS_BADGE_CLASS[recipient.status]}>
                            {t(RECIPIENT_STATUS_KEY[recipient.status])}
                          </Badge>
                          {recipient.status === 'failed' && recipient.error_message && (
                            <p className="mt-1 max-w-[220px] text-[11px] text-red-500">{recipient.error_message}</p>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Pagination page={page} totalPages={totalPages} onChange={setPage} />
            </>
          )}
        </div>
      )}
    </Drawer>
  )
}
