/** Catálogo fijo de transportadoras (data de la app, no del tenant --
 * distinto de warehouses/dispatch_statuses, que sí son configurables por
 * tenant). No hay integración API real con ninguna: `trackingUrl` arma un
 * link al rastreo público de la transportadora a partir del número de
 * guía, para que "Ver seguimiento" mande directo a la página real de la
 * transportadora en vez de abrir nada propio.
 *
 * Los patrones de URL de cada transportadora son un punto de partida, NO
 * verificado contra el sitio real de cada una (no hay forma de probarlo
 * sin una guía real) -- si algún tenant usa alguna de estas, confirmar el
 * formato exacto del link de rastreo antes de darlo por bueno. 'otro' no
 * tiene template a propósito: el campo tracking_url de Dispatch se llena
 * a mano en ese caso. */
export interface Carrier {
  key: string
  name: string
  trackingUrl?: (trackingNumber: string) => string
}

export const CARRIERS: Carrier[] = [
  { key: 'servientrega', name: 'Servientrega', trackingUrl: (n) => `https://www.servientrega.com/wps/portal/rastreo-de-envio?guia=${encodeURIComponent(n)}` },
  { key: 'coordinadora', name: 'Coordinadora', trackingUrl: (n) => `https://coordinadora.com/rastreo-de-envios/?guia=${encodeURIComponent(n)}` },
  { key: 'interrapidisimo', name: 'Inter Rapidísimo', trackingUrl: (n) => `https://interrapidisimo.com/sigue-tu-envio/?guia=${encodeURIComponent(n)}` },
  { key: 'tcc', name: 'TCC', trackingUrl: (n) => `https://www.tcc.com.co/rastreo-de-envios?guia=${encodeURIComponent(n)}` },
  { key: 'envia', name: 'Envía', trackingUrl: (n) => `https://envia.co/rastreo?guia=${encodeURIComponent(n)}` },
  { key: 'deprisa', name: 'Deprisa', trackingUrl: (n) => `https://www.deprisa.com/tracking?guia=${encodeURIComponent(n)}` },
  { key: 'otro', name: 'Otra transportadora' },
]

export function getCarrier(key: string | null): Carrier | undefined {
  return CARRIERS.find((c) => c.key === key)
}

/** Resolves the link "Ver seguimiento" opens -- an explicit manual
 * `trackingUrl` always wins (the only option for carrier_key='otro'),
 * otherwise it's built from the carrier's template + tracking number. */
export function resolveTrackingUrl(carrierKey: string | null, trackingNumber: string | null, manualUrl: string | null): string | null {
  if (manualUrl) return manualUrl
  if (!carrierKey || !trackingNumber) return null
  const carrier = getCarrier(carrierKey)
  return carrier?.trackingUrl ? carrier.trackingUrl(trackingNumber) : null
}
