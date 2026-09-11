/** TypeScript no trae los tipos de WebUSB en su lib DOM estándar -- en vez
 * de sumar una dependencia nueva (`@types/w3c-web-usb`) solo para esto, se
 * declaran acá los pocos tipos que `lib/webUsbPrinter.ts` de verdad usa.
 * No es la spec completa de WebUSB, solo el subconjunto real que llamamos. */
interface USBEndpoint {
  endpointNumber: number
  direction: 'in' | 'out'
}

interface USBAlternateInterface {
  endpoints: USBEndpoint[]
}

interface USBInterface {
  interfaceNumber: number
  alternates: USBAlternateInterface[]
}

interface USBConfiguration {
  interfaces: USBInterface[]
}

interface USBDevice {
  vendorId: number
  productId: number
  productName?: string
  configuration: USBConfiguration | null
  open(): Promise<void>
  close(): Promise<void>
  selectConfiguration(configurationValue: number): Promise<void>
  claimInterface(interfaceNumber: number): Promise<void>
  releaseInterface(interfaceNumber: number): Promise<void>
  transferOut(endpointNumber: number, data: Uint8Array): Promise<{ status: string; bytesWritten: number }>
  forget?(): Promise<void>
}

interface USBDeviceFilter {
  vendorId?: number
  productId?: number
}

interface USBDeviceRequestOptions {
  filters: USBDeviceFilter[]
}

interface USB {
  requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>
  getDevices(): Promise<USBDevice[]>
}

interface Navigator {
  readonly usb: USB
}
