import { CheckIcon } from '@/components/atoms/icons'
/** Shared connected/not-connected status banner shown at the top of every
 * provider's credential drawer -- same visual language across Wompi/
 * LaFactura/Shopify/HubSpot instead of each one inventing its own, mirrors
 * the colored status card pattern from suppliers-web's connection forms. */
export function IntegrationStatusBanner({ connected, connectedText, notConnectedText }: { connected: boolean; connectedText: string; notConnectedText: string }) {
  if (connected) {
    return (
      <div className="flex items-center gap-2.5 rounded-xl border border-emerald-200 bg-emerald-50 px-3.5 py-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
          <CheckIcon width={14} height={14} />
        </span>
        <p className="text-sm font-medium text-emerald-800">{connectedText}</p>
      </div>
    )
  }
  return (
    <div className="rounded-xl border border-brand-100 bg-brand-50/60 px-3.5 py-3">
      <p className="text-sm text-brand-500">{notConnectedText}</p>
    </div>
  )
}
