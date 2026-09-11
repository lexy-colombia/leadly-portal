/** Comandos ESC/POS crudos -- alternativa a `window.print()` cuando el
 * diálogo de impresión del sistema no respeta el tamaño de papel real (ver
 * el comentario de cabecera de `components/pos/ReceiptPrintPortal.tsx`).
 * Sin dependencias: arma directamente los bytes que espera el firmware de
 * la impresora térmica, sin pasar por HTML/CSS/paginación de ningún tipo.
 *
 * Tabla de códigos CP858 (Multilingual Latin I -- `ESC t 19`, la que trae
 * por defecto la Epson TM-T20 para español): solo se necesitan los
 * caracteres reales del idioma (acentos, ñ, ¿/¡) -- cualquier otro
 * carácter fuera de ASCII cae a "?" en vez de mandarle a la impresora un
 * byte que no sabe interpretar (mejor un "?" visible que basura). */
const CP858_MAP: Record<string, number> = {
  á: 0xa0, é: 0x82, í: 0xa1, ó: 0xa2, ú: 0xa3,
  Á: 0xb5, É: 0x90, Í: 0xd6, Ó: 0xe0, Ú: 0xe9,
  ñ: 0xa4, Ñ: 0xa5,
  ü: 0x81, Ü: 0x9a,
  '¿': 0xa8, '¡': 0xad,
  '€': 0xd5, '°': 0xf8,
}

// `Intl.NumberFormat('es-CO', { style: 'currency', ... })` (formatMoney)
// mete un espacio angosto/de no separar entre el símbolo y el número --
// ej. "$ 19.000", no "$19.000" -- ninguno de esos dos es ASCII ni
// está en CP858, así que sin esto caían al "?" genérico y todo monto
// salía como "$?19.000" (bug real reportado, 2026-09-11). Un espacio
// visible es lo correcto acá, no un "?".
const UNICODE_SPACES = new Set([0xa0, 0x2009, 0x202f, 0x2007, 0x2002, 0x2003])

function encodeCp858(text: string): number[] {
  const bytes: number[] = []
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63
    if (code < 128) {
      bytes.push(code)
    } else if (UNICODE_SPACES.has(code)) {
      bytes.push(0x20)
    } else {
      bytes.push(CP858_MAP[ch] ?? 63)
    }
  }
  return bytes
}

/** Ancho útil en caracteres de la fuente A (12x24, la que usa por defecto
 * la TM-T20) según el ancho físico del papel -- valores estándar de la
 * serie TM, no inventados. */
export function receiptColumns(paperWidthMm: 58 | 80): number {
  return paperWidthMm === 58 ? 32 : 48
}

/** Arma un ticket completo como una secuencia de bytes ESC/POS. Todas las
 * medidas de texto (negrita, doble tamaño, alineación) son estado que la
 * propia impresora recuerda entre comandos -- por eso cada método que
 * cambia un estado tiene que dejarlo como lo encontró si no es el último
 * uso, ver `.bold()`/`.doubleSize()` en receiptEscPos.ts. */
export class EscPosBuilder {
  private chunks: number[][] = []
  readonly columns: number

  constructor(paperWidthMm: 58 | 80) {
    this.columns = receiptColumns(paperWidthMm)
    this.chunks.push([0x1b, 0x40]) // ESC @ -- reset a los valores de fábrica
    this.chunks.push([0x1b, 0x74, 0x13]) // ESC t 19 -- codepage CP858
  }

  private push(bytes: number[]): this {
    this.chunks.push(bytes)
    return this
  }

  align(value: 'left' | 'center' | 'right'): this {
    const n = value === 'left' ? 0 : value === 'center' ? 1 : 2
    return this.push([0x1b, 0x61, n])
  }

  bold(on: boolean): this {
    return this.push([0x1b, 0x45, on ? 1 : 0])
  }

  /** Doble alto + doble ancho (GS ! n) -- el único énfasis de tamaño que
   * usa el ticket (nombre del negocio), para no tener que rasterizar el
   * logo como imagen en esta primera versión. */
  doubleSize(on: boolean): this {
    return this.push([0x1d, 0x21, on ? 0x11 : 0x00])
  }

  text(value: string): this {
    return this.push(encodeCp858(value))
  }

  /** Imagen 1 bit (GS v 0, modo normal) -- para el logo del tenant, ya
   * convertido y empaquetado por `escposImage.ts`. `align('center')` antes
   * de llamarla, igual que con el texto. */
  raster(image: { widthPx: number; heightPx: number; data: Uint8Array }): this {
    const rowBytes = Math.ceil(image.widthPx / 8)
    this.push([0x1d, 0x76, 0x30, 0x00, rowBytes & 0xff, (rowBytes >> 8) & 0xff, image.heightPx & 0xff, (image.heightPx >> 8) & 0xff])
    return this.push(Array.from(image.data))
  }

  /** Una línea de texto simple, con salto al final. */
  line(value = ''): this {
    this.text(value)
    return this.push([0x0a])
  }

  /** Fila etiqueta/valor alineada a las dos puntas, como MetaRow en el
   * ticket HTML -- si no entran juntas en el ancho del papel, el valor
   * pasa a su propia línea (nunca se trunca, a diferencia de lo que hacía
   * el diálogo de impresión al no encontrar coincidencia de tamaño). */
  row(label: string, value: string): this {
    const total = this.columns
    if (label.length + value.length + 1 > total) {
      this.line(label)
      return this.push([0x1b, 0x61, 2]).line(value).push([0x1b, 0x61, 0])
    }
    const gap = total - label.length - value.length
    return this.line(label + ' '.repeat(Math.max(1, gap)) + value)
  }

  /** Línea punteada de separación, del mismo ancho que el papel. */
  rule(): this {
    return this.line('-'.repeat(this.columns))
  }

  feed(lines = 1): this {
    return this.push([0x1b, 0x64, lines])
  }

  /** Código QR nativo de la impresora (GS ( k, modelo 2) -- la propia
   * Epson lo genera desde el string, no hace falta rasterizar ninguna
   * imagen ni depender de la librería `qrcode` del lado del navegador. */
  qr(data: string, moduleSize = 6): this {
    const dataBytes = encodeCp858(data)
    const storeLen = dataBytes.length + 3
    const pL = storeLen & 0xff
    const pH = (storeLen >> 8) & 0xff
    this.push([0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]) // modelo 2
    this.push([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize]) // tamaño de módulo
    this.push([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]) // corrección de errores nivel M
    this.push([0x1d, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...dataBytes]) // almacenar datos
    return this.push([0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]) // imprimir
  }

  /** Corte parcial -- deja un puente de papel, el mismo comportamiento que
   * el corte automático que ya hacía la Epson con el diálogo del sistema. */
  cut(): this {
    this.feed(3)
    return this.push([0x1d, 0x56, 0x01])
  }

  toBytes(): Uint8Array {
    const length = this.chunks.reduce((sum, c) => sum + c.length, 0)
    const out = new Uint8Array(length)
    let offset = 0
    for (const chunk of this.chunks) {
      out.set(chunk, offset)
      offset += chunk.length
    }
    return out
  }
}
