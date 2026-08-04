import { Button } from './Button'

export function PageSpinner() {
  return (
    <div className="flex h-full min-h-[40vh] w-full items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand-200 border-t-accent-500" />
    </div>
  )
}

export function AccessDenied() {
  return (
    <div className="flex h-full min-h-[40vh] w-full flex-col items-center justify-center gap-2 p-6 text-center">
      <h2 className="text-xl font-semibold text-brand-700">Acceso denegado</h2>
      <p className="text-sm text-brand-400">No tienes permisos para ver esta sección. Contacta a tu administrador si crees que esto es un error.</p>
    </div>
  )
}

export function TenantDeactivated({ tenantName, onSignOut }: { tenantName: string | undefined; onSignOut: () => void }) {
  return (
    <div className="flex h-screen w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <h2 className="text-xl font-semibold text-brand-700">Tu empresa está desactivada</h2>
      <p className="max-w-sm text-sm text-brand-400">
        {tenantName ? (
          <>
            La cuenta de <span className="font-medium">{tenantName}</span> en Leadly está desactivada
          </>
        ) : (
          'La cuenta de tu empresa en Leadly está desactivada'
        )}
        . Contacta a tu administrador de Leadly para reactivarla.
      </p>
      <Button variant="ghost" onClick={onSignOut} className="mt-2">
        Cerrar sesión
      </Button>
    </div>
  )
}
