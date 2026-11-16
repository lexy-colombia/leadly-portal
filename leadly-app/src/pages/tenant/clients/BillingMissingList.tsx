import type { BillingMissingKey } from '../../../lib/billingProfile'
import { useLanguage } from '../../../contexts/LanguageContext'
import type { TranslationKey } from '../../../i18n/translations'

/** Qué le falta a un perfil para poder emitir la factura. Informativo: el
 * servidor decide al emitir (su lista llega como `billing_missing`). Acepta
 * claves locales (espejo) o textos ya armados por el servidor. */
export function BillingMissingList({ keys, serverMissing }: { keys?: BillingMissingKey[]; serverMissing?: string[] }) {
  const { t } = useLanguage()
  const items = [...(keys ?? []).map((k) => t(`contacts.billingProfiles.missing.${k}` as TranslationKey)), ...(serverMissing ?? [])]
  if (items.length === 0) return null
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800" role="status">
      <p className="font-medium">{t('contacts.billingProfiles.missing.title')}</p>
      <ul className="mt-1 list-disc pl-4">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
