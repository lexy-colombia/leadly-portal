import { useEffect, useRef, useState } from 'react'
import { Drawer } from '@/components/organisms'
import { Button } from '@/components/ui/button'
import { useLanguage } from '../../../contexts/LanguageContext'
import { CopyButton } from './CopyButton'

export interface RevealedSecrets {
  projectName: string
  kind: 'created' | 'rotated'
  apiKey: string
  /** Solo al crear el proyecto; rotar la clave no cambia el secreto de firma. */
  signingSecret?: string
}

function SecretRow({ id, label, value }: { id: string; label: string; value: string }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-brand-700">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          readOnly
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          className="min-w-0 flex-1 rounded-lg border border-brand-200 bg-brand-50 px-2.5 py-1.5 font-mono text-xs text-brand-800"
        />
        <CopyButton value={value} />
      </div>
    </div>
  )
}

/** Muestra api_key / signing_secret UNA sola vez. El drawer no se deja
 * cerrar (backdrop, Escape, "Cerrar") hasta que se marque que ya se
 * guardaron: una vez cerrado no hay forma de volver a verlos. */
export function PaymentSecretsDrawer({ secrets, onClose }: { secrets: RevealedSecrets | null; onClose: () => void }) {
  const { t } = useLanguage()
  const [acknowledged, setAcknowledged] = useState(false)
  const [warn, setWarn] = useState(false)
  const ackRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (secrets) {
      setAcknowledged(false)
      setWarn(false)
      // Foco al abrir: el aviso es lo primero que se lee, el checkbox lo primero que se opera.
      window.setTimeout(() => ackRef.current?.focus(), 0)
    }
  }, [secrets])

  function handleClose() {
    if (!acknowledged) {
      setWarn(true)
      return
    }
    onClose()
  }

  return (
    <Drawer
      open={!!secrets}
      onClose={handleClose}
      title={
        secrets
          ? t(secrets.kind === 'created' ? 'paymentLinks.secrets.titleCreated' : 'paymentLinks.secrets.titleRotated', { name: secrets.projectName })
          : ''
      }
    >
      {secrets && (
        <div className="space-y-4">
          <p role="alert" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {t('paymentLinks.secrets.warning')}
          </p>
          <SecretRow id="pay-secret-api-key" label={t('paymentLinks.secrets.apiKey')} value={secrets.apiKey} />
          {secrets.signingSecret && <SecretRow id="pay-secret-signing" label={t('paymentLinks.secrets.signingSecret')} value={secrets.signingSecret} />}

          <label className="flex items-start gap-2 text-xs text-brand-700">
            <input ref={ackRef} type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} className="mt-0.5" />
            {t('paymentLinks.secrets.ack')}
          </label>
          {warn && !acknowledged && <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{t('paymentLinks.secrets.mustAck')}</p>}

          <div className="border-t border-brand-100 pt-5">
            <Button type="button" onClick={handleClose}>
              {t('paymentLinks.secrets.done')}
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  )
}
