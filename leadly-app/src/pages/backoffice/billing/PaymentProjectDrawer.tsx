import { useEffect, useState, type FormEvent } from 'react'
import { createPaymentClient, updatePaymentClient, type PaymentClient } from '../../../lib/api/paymentLinks'
import { FieldError } from '@/components/atoms'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLanguage } from '../../../contexts/LanguageContext'
import { useToast } from '../../../contexts/ToastContext'
import type { RevealedSecrets } from './PaymentSecretsDrawer'

/** Alta / edición de un proyecto conectado. Alta: nombre + URL de aviso;
 * al guardar bien se cierra y devuelve las credenciales (una sola vez) para
 * que el padre las muestre. Edición: solo la URL de aviso (el contrato no
 * permite renombrar). */
export function PaymentProjectDrawer({
  open,
  onClose,
  project,
  onSaved,
  onSecrets,
}: {
  open: boolean
  onClose: () => void
  project: PaymentClient | null
  onSaved: () => void
  onSecrets: (secrets: RevealedSecrets) => void
}) {
  const { t } = useLanguage()
  const toast = useToast()
  const [name, setName] = useState('')
  const [callbackUrl, setCallbackUrl] = useState('')
  const [touched, setTouched] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(project?.name ?? '')
    setCallbackUrl(project?.callback_url ?? '')
    setTouched(false)
    setFormError(null)
  }, [open, project])

  const nameError = !project && touched && !name.trim() ? t('paymentLinks.projectDrawer.errors.name') : undefined

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setTouched(true)
    setFormError(null)
    if (!project && !name.trim()) return
    setSubmitting(true)
    try {
      if (project) {
        await updatePaymentClient(project.id, { callbackUrl: callbackUrl.trim() || null })
        toast.success(t('paymentLinks.projectDrawer.updated'))
      } else {
        const created = await createPaymentClient({ name: name.trim(), callbackUrl: callbackUrl.trim() || null })
        toast.success(t('paymentLinks.projectDrawer.created'))
        onSecrets({
          projectName: created.client?.name ?? name.trim(),
          kind: 'created',
          apiKey: created.api_key,
          signingSecret: created.signing_secret,
        })
      }
      onSaved()
      onClose()
    } catch (err) {
      const message = err instanceof Error ? err.message : t('common.status.error')
      setFormError(message)
      toast.error(message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={project ? t('paymentLinks.projectDrawer.titleEdit') : t('paymentLinks.projectDrawer.titleNew')}
      description={t('paymentLinks.projectDrawer.description')}
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        <div>
          <Label htmlFor="pay-project-name">{t('paymentLinks.projectDrawer.name')}</Label>
          <Input
            id="pay-project-name"
            autoFocus={!project}
            value={name}
            disabled={!!project}
            aria-invalid={!!nameError}
            onChange={(e) => setName(e.target.value)}
          />
          <FieldError message={nameError} />
        </div>
        <div>
          <Label htmlFor="pay-project-callback">{t('paymentLinks.projectDrawer.callbackUrl')}</Label>
          <Input
            id="pay-project-callback"
            autoFocus={!!project}
            type="url"
            inputMode="url"
            value={callbackUrl}
            onChange={(e) => setCallbackUrl(e.target.value)}
            placeholder="https://"
            aria-describedby="pay-project-callback-hint"
          />
          <p id="pay-project-callback-hint" className="mt-1 text-xs text-brand-400">
            {t('paymentLinks.projectDrawer.callbackHint')}
          </p>
        </div>

        {formError && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">
            {formError}
          </p>
        )}

        <div className="flex gap-2 border-t border-brand-100 pt-5">
          <Button type="submit" disabled={submitting}>
            {submitting ? t('common.actions.saving') : t('common.actions.save')}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.actions.cancel')}
          </Button>
        </div>
      </form>
    </Drawer>
  )
}
