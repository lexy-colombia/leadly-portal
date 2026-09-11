/** Impresión térmica directa por WebUSB -- se manda el ticket armado por
 * `escpos.ts` derecho a la impresora, sin pasar por `window.print()` ni por
 * el diálogo de impresión del sistema (ver el comentario de cabecera de
 * `components/pos/ReceiptPrintPortal.tsx` sobre por qué ese camino no es
 * confiable con esta impresora: el driver necesita que el tamaño de papel
 * coincida EXACTO con lo que tiene registrado, y cuando no coincide corta
 * el ticket, a veces por el costado). Sin dependencias -- WebUSB es una API
 * nativa del navegador, solo Chrome/Edge (`isWebUsbSupported`). */

const EPSON_VENDOR_ID = 0x04b8 // Seiko Epson Corp.

export function isWebUsbSupported(): boolean {
  return typeof navigator !== 'undefined' && 'usb' in navigator
}

/** Solo se puede llamar desde un gesto real del usuario (click) -- WebUSB
 * exige eso para abrir el selector del navegador. El permiso que el
 * usuario otorga acá queda guardado por el navegador a nivel de este
 * origen; `getPairedPrinter()` lo recupera solo, sin volver a preguntar. */
export async function requestPrinter(): Promise<USBDevice> {
  return navigator.usb.requestDevice({ filters: [{ vendorId: EPSON_VENDOR_ID }] })
}

/** La impresora ya emparejada en una sesión anterior, si existe -- filtra
 * por el vendor ID de Epson primero; si el navegador tiene autorizado
 * algún otro dispositivo (poco común, pero posible si alguna vez se
 * emparejó por error), lo devuelve igual antes que nada en vez de fallar
 * en silencio. */
export async function getPairedPrinter(): Promise<USBDevice | null> {
  if (!isWebUsbSupported()) return null
  const devices = await navigator.usb.getDevices()
  return devices.find((d) => d.vendorId === EPSON_VENDOR_ID) ?? devices[0] ?? null
}

export async function forgetPrinter(device: USBDevice): Promise<void> {
  await device.forget?.()
}

/** Manda los bytes crudos a la impresora ya emparejada -- abre, reclama la
 * primera interfaz con un endpoint de salida (no hay forma genérica de
 * adivinar el número de interfaz entre modelos de impresora), escribe, y
 * cierra. Se abre y se cierra en cada impresión -- no se mantiene la
 * conexión abierta entre tickets, para no pelear con el sistema operativo
 * si alguna otra app también habla con la misma impresora mientras tanto. */
export async function printRaw(bytes: Uint8Array): Promise<void> {
  const device = await getPairedPrinter()
  if (!device) throw new Error('No hay ninguna impresora emparejada -- conectala desde Configuración > Documentos y tickets.')

  await device.open()
  try {
    if (device.configuration === null) await device.selectConfiguration(1)

    const iface = device.configuration?.interfaces.find((i) => i.alternates.some((alt) => alt.endpoints.some((ep) => ep.direction === 'out')))
    if (!iface) throw new Error('La impresora emparejada no tiene ninguna interfaz de impresión reconocible.')

    const alternate = iface.alternates.find((alt) => alt.endpoints.some((ep) => ep.direction === 'out'))!
    const endpoint = alternate.endpoints.find((ep) => ep.direction === 'out')!

    await device.claimInterface(iface.interfaceNumber)
    try {
      await device.transferOut(endpoint.endpointNumber, bytes)
    } finally {
      await device.releaseInterface(iface.interfaceNumber)
    }
  } finally {
    await device.close()
  }
}
