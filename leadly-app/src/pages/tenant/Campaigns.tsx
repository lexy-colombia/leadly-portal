import { useEffect, useState } from 'react'
import { Copy as CopyIcon } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useLanguage } from '../../contexts/LanguageContext'
import type { TranslationKey } from '../../i18n/translations'
import { listCampaigns, listCampaignRecipients } from '../../lib/api/campaigns'
import type { CampaignWithRelations } from '../../lib/api/campaigns'
import type { CampaignRecipient, CampaignStatus } from '../../types/domain'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState, Pagination } from '@/components/molecules'
import { PencilIcon, PlusIcon } from '@/components/atoms/icons'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CampaignFormDrawer, defaultScheduledAt, toDatetimeLocalValue } from './campaigns/CampaignFormDrawer'
import type { CampaignFormInitial } from './campaigns/CampaignFormDrawer'
import { CampaignDetailDrawer } from './campaigns/CampaignDetailDrawer'

const PAGE_SIZE = 10

export const CAMPAIGN_STATUS_KEY: Record<CampaignStatus, TranslationKey> = {
  draft: 'campaigns.status.draft',
  scheduled: 'campaigns.status.scheduled',
  sending: 'campaigns.status.sending',
  completed: 'campaigns.status.completed',
  canceled: 'campaigns.status.canceled',
  failed: 'campaigns.status.failed',
}

export const CAMPAIGN_STATUS_BADGE_CLASS: Record<CampaignStatus, string> = {
  draft: 'border-transparent bg-slate-100 text-slate-600',
  scheduled: 'border-transparent bg-amber-100 text-amber-700',
  sending: 'border-transparent bg-sky-100 text-sky-700',
  completed: 'border-transparent bg-emerald-100 text-emerald-700',
  canceled: 'border-transparent bg-slate-100 text-slate-600',
  failed: 'border-transparent bg-red-100 text-red-700',
}

export function Campaigns() {
  const { profile } = useAuth()
  const { t, language } = useLanguage()
  const [campaigns, setCampaigns] = useState<CampaignWithRelations[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [formOpen, setFormOpen] = useState(false)
  const [formMode, setFormMode] = useState<'create' | 'edit'>('create')
  const [formCampaignId, setFormCampaignId] = useState<string | undefined>(undefined)
  const [formInitial, setFormInitial] = useState<CampaignFormInitial | null>(null)
  // Cambia en cada apertura del drawer -- fuerza a CampaignFormDrawer a
  // remontar con estado fresco (ver comentario ahí) en vez de depender de un
  // useEffect para resetear cada campo a mano.
  const [formKey, setFormKey] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null)

  function reload() {
    if (!profile?.tenant_id) return
    listCampaigns(profile.tenant_id)
      .then(setCampaigns)
      .catch((err) => setError(err.message ?? t('campaigns.errors.load')))
  }

  useEffect(reload, [profile?.tenant_id])

  function openCreate() {
    setFormMode('create')
    setFormCampaignId(undefined)
    setFormInitial(null)
    setFormKey((k) => k + 1)
    setFormOpen(true)
  }

  function openEdit(campaign: CampaignWithRelations, recipients: CampaignRecipient[]) {
    setFormMode('edit')
    setFormCampaignId(campaign.id)
    setFormInitial({
      name: campaign.name,
      templateId: campaign.template_id,
      lineId: campaign.whatsapp_line_id,
      topic: campaign.topic ?? '',
      scheduledAt: toDatetimeLocalValue(campaign.scheduled_at),
      recipients: recipients.map((r) => ({ contact_phone: r.contact_phone, contact_name: r.contact_name ?? '', variables: r.variables })),
    })
    setFormKey((k) => k + 1)
    setFormOpen(true)
  }

  function openDuplicate(campaign: CampaignWithRelations, recipients: CampaignRecipient[]) {
    setFormMode('create')
    setFormCampaignId(undefined)
    setFormInitial({
      name: `${campaign.name} ${t('campaigns.newDrawer.duplicateSuffix')}`,
      templateId: campaign.template_id,
      lineId: campaign.whatsapp_line_id,
      topic: campaign.topic ?? '',
      scheduledAt: defaultScheduledAt(),
      recipients: recipients.map((r) => ({ contact_phone: r.contact_phone, contact_name: r.contact_name ?? '', variables: r.variables })),
    })
    setFormKey((k) => k + 1)
    setFormOpen(true)
  }

  async function handleEditClick(campaign: CampaignWithRelations) {
    setActionLoadingId(campaign.id)
    try {
      const recipients = await listCampaignRecipients(campaign.id)
      openEdit(campaign, recipients)
    } finally {
      setActionLoadingId(null)
    }
  }

  async function handleDuplicateClick(campaign: CampaignWithRelations) {
    setActionLoadingId(campaign.id)
    try {
      const recipients = await listCampaignRecipients(campaign.id)
      openDuplicate(campaign, recipients)
    } finally {
      setActionLoadingId(null)
    }
  }

  const totalPages = campaigns ? Math.max(1, Math.ceil(campaigns.length / PAGE_SIZE)) : 1
  const pageItems = campaigns ? campaigns.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE) : null

  const locale = language === 'en' ? 'en-US' : 'es-CO'

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={openCreate} size="sm">
          <PlusIcon width={14} height={14} /> {t('campaigns.actions.new')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      {!campaigns && !error && <PageSpinner />}

      {campaigns && campaigns.length === 0 && (
        <Card>
          <EmptyState>{t('campaigns.empty')}</EmptyState>
        </Card>
      )}

      {pageItems && pageItems.length > 0 && (
        <>
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('campaigns.table.name')}</TableHead>
                  <TableHead>{t('campaigns.table.template')}</TableHead>
                  <TableHead>{t('campaigns.table.line')}</TableHead>
                  <TableHead>{t('campaigns.table.scheduledAt')}</TableHead>
                  <TableHead>{t('campaigns.table.status')}</TableHead>
                  <TableHead>{t('campaigns.table.progress')}</TableHead>
                  <TableHead className="text-right">{t('campaigns.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageItems.map((campaign) => (
                  <TableRow key={campaign.id} className="cursor-pointer" onClick={() => setSelectedId(campaign.id)}>
                    <TableCell className="text-xs font-medium text-brand-800">{campaign.name}</TableCell>
                    <TableCell className="text-xs text-brand-500">{campaign.template?.name ?? '-'}</TableCell>
                    <TableCell className="text-xs text-brand-500">{campaign.whatsapp_line?.display_name ?? '-'}</TableCell>
                    <TableCell className="text-xs text-brand-500">
                      {new Date(campaign.scheduled_at).toLocaleString(locale, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={CAMPAIGN_STATUS_BADGE_CLASS[campaign.status]}>
                        {t(CAMPAIGN_STATUS_KEY[campaign.status])}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-brand-500">
                      {campaign.sent_count + campaign.failed_count}/{campaign.total_recipients}
                    </TableCell>
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      <span className="inline-flex items-center gap-1">
                        {campaign.status === 'scheduled' && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t('common.actions.edit')}
                            disabled={actionLoadingId === campaign.id}
                            onClick={() => handleEditClick(campaign)}
                          >
                            <PencilIcon width={12} height={12} />
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t('campaigns.detail.duplicateCampaign')}
                          disabled={actionLoadingId === campaign.id}
                          onClick={() => handleDuplicateClick(campaign)}
                        >
                          <CopyIcon width={12} height={12} />
                        </Button>
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={page} totalPages={totalPages} onChange={setPage} />
        </>
      )}

      {profile?.tenant_id && (
        <CampaignFormDrawer
          key={formKey}
          open={formOpen}
          onClose={() => setFormOpen(false)}
          tenantId={profile.tenant_id}
          mode={formMode}
          campaignId={formCampaignId}
          initial={formInitial}
          onSaved={() => {
            setFormOpen(false)
            reload()
          }}
        />
      )}

      <CampaignDetailDrawer campaignId={selectedId} onClose={() => setSelectedId(null)} onChanged={reload} />
    </div>
  )
}
