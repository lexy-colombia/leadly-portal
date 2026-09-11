/** Convierte una imagen remota (el logo del tenant) a un raster ESC/POS de
 * 1 bit -- necesario para poder imprimirlo por WebUSB (lib/webUsbPrinter.ts),
 * donde no hay ningún `<img>` ni CSS que la impresora pueda interpretar
 * sola, a diferencia del camino de `window.print()`. Nunca bloquea el
 * ticket si falla: mismo criterio que el `<img>` del ticket HTML, que
 * tampoco corta la impresión si no carga (ver `rasterizeLogoForEscPos`,
 * siempre devuelve `null` en vez de tirar). */
export interface EscPosRaster {
  widthPx: number
  heightPx: number
  /** Bytes ya empaquetados fila por fila, 1 bit por punto, MSB primero --
   * listo para pegar después del comando GS v 0 que arma EscPosBuilder.raster(). */
  data: Uint8Array
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('No se pudo cargar la imagen'))
    img.src = url
  })
}

/** Achica al alto/ancho pedidos (manteniendo proporción, el que primero
 * toque el límite manda), dibuja sobre fondo BLANCO real -- un logo con
 * transparencia tiene que leerse como "no imprime" ahí, no como negro
 * (alpha=0 sin este fondo) --, y aplica Floyd-Steinberg (mejor resultado
 * que un umbral fijo en bordes suavizados, la norma en cualquier logo
 * real) para pasar a blanco y negro puro. */
export async function rasterizeLogoForEscPos(url: string, maxWidthPx: number, targetHeightPx: number): Promise<EscPosRaster | null> {
  try {
    const img = await loadImage(url)
    let heightPx = targetHeightPx
    let widthPx = Math.round((img.naturalWidth * heightPx) / img.naturalHeight)
    if (widthPx > maxWidthPx) {
      widthPx = maxWidthPx
      heightPx = Math.round((img.naturalHeight * widthPx) / img.naturalWidth)
    }
    widthPx = Math.max(1, widthPx)
    heightPx = Math.max(1, heightPx)

    const canvas = document.createElement('canvas')
    canvas.width = widthPx
    canvas.height = heightPx
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, widthPx, heightPx)
    ctx.drawImage(img, 0, 0, widthPx, heightPx)

    const { data: rgba } = ctx.getImageData(0, 0, widthPx, heightPx)
    const luminance = new Float32Array(widthPx * heightPx)
    for (let i = 0; i < widthPx * heightPx; i++) {
      luminance[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]
    }

    const black = new Uint8Array(widthPx * heightPx)
    const spread = (x: number, y: number, error: number, dx: number, dy: number, factor: number) => {
      const nx = x + dx
      const ny = y + dy
      if (nx < 0 || nx >= widthPx || ny < 0 || ny >= heightPx) return
      luminance[ny * widthPx + nx] += error * factor
    }
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < widthPx; x++) {
        const idx = y * widthPx + x
        const old = luminance[idx]
        const isBlack = old < 128
        black[idx] = isBlack ? 1 : 0
        const error = old - (isBlack ? 0 : 255)
        spread(x, y, error, 1, 0, 7 / 16)
        spread(x, y, error, -1, 1, 3 / 16)
        spread(x, y, error, 0, 1, 5 / 16)
        spread(x, y, error, 1, 1, 1 / 16)
      }
    }

    const rowBytes = Math.ceil(widthPx / 8)
    const packed = new Uint8Array(rowBytes * heightPx)
    for (let y = 0; y < heightPx; y++) {
      for (let x = 0; x < widthPx; x++) {
        if (!black[y * widthPx + x]) continue
        packed[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7)
      }
    }

    return { widthPx, heightPx, data: packed }
  } catch {
    return null
  }
}
