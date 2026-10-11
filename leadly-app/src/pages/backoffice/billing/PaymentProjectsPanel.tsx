import { useState } from 'react'
import { rotatePaymentClientKey, updatePaymentClient, type PaymentClient } from '../../../lib/api/paymentLinks'
import { PageSpinner } from '@/components/atoms'
import { Card, EmptyState } from '@/components/molecules'
import { PlusIcon } from '@/components/atoms/icons'
import { ConfirmDialog } from '@/components/organisms'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'
import { PaymentProjectDrawer } from './PaymentProjectDrawer'
import { PaymentSecretsDrawer, type RevealedSecrets } from './PaymentSecretsDrawer'

export function PaymentProjectsPanel({
  projects,
  error,
  onReload,
}: {
  /** null = cargando. */
  projects: PaymentClient[] | null
  error: string | null
  onReload: () => void
}) {
  const { t } = useLanguage()
  const toast = useToast()
  const [drawer, setDrawer] = useState<{ open: boolean; project: PaymentClient | null }>({ open: false, project: null })
  const [secrets, setSecrets] = useState<RevealedSecrets | null>(null)
  const [rotateTarget, setRotateTarget] = useState<PaymentClient | null>(null)
  const [suspendTarget, setSuspendTarget] = useState<PaymentClient | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)

  async function handleRotate() {
    if (!rotateTarget) return
    setBusy(true)
    setDialogError(null)
    try {
      const result = await rotatePaymentClientKey(rotateTarget.id)
      setSecrets({ projectName: rotateTarget.name, kind: 'rotated', apiKey: result.api_key })
      setRotateTarget(null)
      onReload()
    } catch (err) {
      setDialogError(err instanceof Error ? err.message : t('common.status.error'))
    } finally {
      setBusy(false)
    }
  }

  async function changeStatus(project: PaymentClient, status: 'active' | 'suspended', fromDialog: boolean) {
    setBusy(true)
    if (fromDialog) setDialogError(null)
    try {
      await updatePaymentClient(project.id, { status })
      toast.success(t('paymentLinks.projects.statusUpdated'))
      setSuspendTarget(null)
      onReload()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.status.error')
      if (fromDialog) setDialogError(message)
      else toast.error(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-xs font-bold text-brand-800">{t('paymentLinks.projects.title')}</h3>
            <p className="text-xs text-brand-400">{t('paymentLinks.projects.subtitle')}</p>
          </div>
          <Button size="sm" onClick={() => setDrawer({ open: true, project: null })}>
            <PlusIcon width={14} height={14} /> {t('paymentLinks.projects.new')}
          </Button>
        </div>

        {error && (
          <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            <span>
              {t('paymentLinks.projects.loadError')} {error}
            </span>
            <Button variant="outline" size="xs" onClick={onReload}>
              {t('common.actions.retry')}
            </Button>
          </div>
        )}
        {!projects && !error && <PageSpinner />}
        {projects && projects.length === 0 && <EmptyState>{t('paymentLinks.projects.empty')}</EmptyState>}
        {projects && projects.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-brand-100 bg-white">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('paymentLinks.projects.table.name')}</TableHead>
                  <TableHead className="hidden sm:table-cell">{t('paymentLinks.projects.table.keyPrefix')}</TableHead>
                  <TableHead className="hidden md:table-cell">{t('paymentLinks.projects.table.callback')}</TableHead>
                  <TableHead>{t('paymentLinks.projects.table.status')}</TableHead>
                  <TableHead className="text-right">{t('paymentLinks.projects.table.actions')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {projects.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium text-brand-800">{p.name}</TableCell>
                    <TableCell className="hidden font-mono text-brand-500 sm:table-cell">{p.key_prefix ? `${p.key_prefix}…` : '—'}</TableCell>
                    <TableCell className="hidden max-w-[220px] truncate text-brand-500 md:table-cell" title={p.callback_url ?? undefined}>
                      {p.callback_url ?? t('paymentLinks.projects.noCallback')}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={p.status === 'active' ? 'border-transparent bg-emerald-100 text-emerald-700' : 'border-transparent bg-slate-100 text-slate-600'}
                      >
                        {t(p.status === 'active' ? 'paymentLinks.projects.status.active' : 'paymentLinks.projects.status.suspended')}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex flex-wrap items-center justify-end gap-1">
                        <Button variant="ghost" size="xs" onClick={() => setDrawer({ open: true, project: p })}>
                          {t('paymentLinks.projects.edit')}
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setRotateTarget(p)}>
                          {t('paymentLinks.projects.rotate')}
                        </Button>
                        {p.status === 'active' ? (
                          <Button variant="ghost" size="xs" onClick={() => setSuspendTarget(p)}>
                            {t('paymentLinks.projects.suspend')}
                          </Button>
                        ) : (
                          <Button variant="ghost" size="xs" disabled={busy} onClick={() => changeStatus(p, 'active', false)}>
                            {t('paymentLinks.projects.activate')}
                          </Button>
                        )}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <PaymentProjectDrawer
        open={drawer.open}
        project={drawer.project}
        onClose={() => setDrawer({ open: false, project: null })}
        onSaved={onReload}
        onSecrets={setSecrets}
      />
      <PaymentSecretsDrawer secrets={secrets} onClose={() => setSecrets(null)} />

      <ConfirmDialog
        open={!!rotateTarget}
        onClose={() => {
          setRotateTarget(null)
          setDialogError(null)
        }}
        onConfirm={handleRotate}
        title={t('paymentLinks.projects.rotateConfirm.title', { name: rotateTarget?.name ?? '' })}
        description={t('paymentLinks.projects.rotateConfirm.description')}
        confirmLabel={t('paymentLinks.projects.rotateConfirm.action')}
        loading={busy}
        error={dialogError}
      />
      <ConfirmDialog
        open={!!suspendTarget}
        onClose={() => {
          setSuspendTarget(null)
          setDialogError(null)
        }}
        onConfirm={() => suspendTarget && changeStatus(suspendTarget, 'suspended', true)}
        title={t('paymentLinks.projects.suspendConfirm.title', { name: suspendTarget?.name ?? '' })}
        description={t('paymentLinks.projects.suspendConfirm.description')}
        confirmLabel={t('paymentLinks.projects.suspendConfirm.action')}
        loading={busy}
        error={dialogError}
      />
    </>
  )
}
