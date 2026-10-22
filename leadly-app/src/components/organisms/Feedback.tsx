import { Button } from '@/components/atoms/Button'
import { useLanguage } from '@/contexts/LanguageContext'

export function AccessDenied() {
  return (
    <div className="flex h-full min-h-[40vh] w-full flex-col items-center justify-center gap-2 p-6 text-center">
      <h2 className="text-xs font-semibold text-brand-700">Acceso denegado</h2>
      <p className="text-xs text-brand-400">No tienes permisos para ver esta sección. Contacta a tu administrador si crees que esto es un error.</p>
    </div>
  )
}

/** Bloqueo MANUAL del superadmin (suspension_reason null). El bloqueo por mora usa TenantSuspendedNonpayment. */
export function TenantDeactivated({ tenantName, onSignOut }: { tenantName: string | undefined; onSignOut: () => void }) {
  const { t } = useLanguage()
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-xs font-semibold text-brand-700">{t('billing.suspended.title')}</h2>
      <p className="max-w-sm text-xs text-brand-400">
        {tenantName ? t('billing.suspended.description', { name: tenantName }) : t('billing.suspended.descriptionNoName')}
      </p>
      <Button variant="ghost" onClick={onSignOut} className="mt-2">
        {t('billing.wall.signOut')}
      </Button>
    </div>
  )
}
