import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

// Referencia de la spec de CSS (1 px = 1/96 de pulgada, sea cual sea el DPI
// físico de la pantalla o de la impresora) -- el navegador usa esta misma
// equivalencia para pasar el layout en píxeles a las unidades absolutas
// (mm) que declara `@page`, tanto en pantalla como al imprimir. Es lo que
// permite medir el alto en píxeles y confiar en que da el mismo alto real
// en papel.
const PX_PER_MM = 96 / 25.4

/** Imprime UN ticket a la vez: se monta con el contenido ya armado
 * -- fuera de pantalla pero completamente renderizado, con el mismo ancho y
 * tipografía que va a usar el papel real --, mide su alto real, recién ahí
 * arma el `@page` con las dos medidas fijas y dispara el diálogo de
 * impresión del sistema. Se desmonta solo cuando el diálogo se cierra (se
 * imprima o se cancele). Nunca imprime en silencio -- ver el comentario de
 * la migración 20260904190000 sobre por qué eso requeriría un agente local
 * aparte.
 *
 * Por qué la medición en dos fases (y no `@page { size: 80mm auto }` como
 * antes): la spec de CSS Paged Media no permite mezclar una medida fija con
 * `auto` en `size` -- solo `auto` solo (que significa "el tamaño de la
 * hoja del destino", no "lo que mida el contenido") o dos medidas fijas.
 * `80mm auto` es inválido, así que el navegador descartaba la regla
 * entera y caía en su hoja por defecto -- el bug real detrás de "siempre me
 * sale una hoja tamaño carta" (2026-09-05, reportado por el usuario). Con
 * las dos medidas fijas (ancho del papel configurado + alto real del
 * ticket + un margen de corte) el navegador arma una página angosta a
 * medida en vez de una Carta/A4 completa.
 *
 * Genérico a propósito: no sabe nada de `PosReceiptData` -- recibe
 * `children` ya armado, así que el mismo portal (y el mismo CSS de
 * impresión) sirve tanto para el ticket final (PosReceiptTicket, con pago y
 * datos fiscales) como para la vista previa de "lo que tengo cargado"
 * (PosPendingReceiptTicket, antes de cobrar) -- ver usePosReceiptPrinter.
 *
 * Truco de "imprimir solo esto": el contenido se monta vía createPortal
 * directo en document.body (hermano de #root, no un hijo). Mientras la app
 * está en uso vive fuera de pantalla (`position: fixed; left: -10000px`,
 * no `display:none` -- necesita estar realmente dispuesto en el layout
 * para poder medirlo); recién bajo `@media print` vuelve a flujo normal, a
 * la vez que el mismo bloque oculta el resto de la SPA (`#root`). Así no
 * hace falta ningún iframe ni ventana aparte, y el resto de la app sigue
 * viva e intacta detrás. */
export function ReceiptPrintPortal({ children, paperWidth, onDone }: { children: ReactNode; paperWidth: '58mm' | '80mm'; onDone: () => void }) {
  const contentRef = useRef<HTMLDivElement>(null)
  const printedRef = useRef(false)
  const [pageHeightMm, setPageHeightMm] = useState<number | null>(null)

  const widthMm = paperWidth === '58mm' ? 58 : 80
  // Margen lateral real: sin esto el contenido llega borde a borde y la
  // mayoría de impresoras térmicas (área imprimible siempre algo menor que
  // el ancho físico del papel) cortan las últimas columnas -- hallazgo real
  // del usuario en 80mm. `box-sizing: border-box` hace que el padding se
  // reste del ancho declarado, no se sume, así que el papel sigue midiendo
  // exactamente `widthMm`. Bajado de 3/2mm a 1mm (2026-09-05): con un
  // "Papel definido por el usuario" configurado en el driver (Epson APD),
  // ese margen ya puede venir sumado del lado del driver -- este es el
  // único margen que controlamos con certeza desde acá, así que se achica
  // al mínimo que sigue evitando el corte de borde reportado antes.
  const sideMarginMm = 1
  const fontSizePx = widthMm === 58 ? 11 : 12

  // Fase 1: medir. Un tick para que el contenido (ya con su ancho y
  // tipografía final, solo que fuera de pantalla) termine de pintar antes
  // de leer su alto real -- mismo motivo que el tick que antes precedía a
  // `window.print()` directamente.
  useEffect(() => {
    const timer = setTimeout(() => {
      const contentPx = contentRef.current?.scrollHeight ?? 0
      // +4mm de margen de cortina: que la última línea nunca quede al ras
      // del corte del rollo, y que un redondeo mínimo entre la medición en
      // pantalla y el layout real de impresión (que sí puede diferir un par
      // de px por hinting de fuente) nunca deje el cálculo justo corto. No
      // hace falta más que esto -- el break-inside:avoid de abajo ya es la
      // protección real contra una segunda página si el cálculo fallara,
      // este margen es solo estético. Piso de 30mm para no terminar con una
      // página absurdamente chica si por lo que sea el contenido midiera ~0.
      // Ojo: el espacio que una Epson TM-T-series deja arriba/abajo del
      // rollo NO sale de acá -- es el margen no imprimible que el driver
      // reporta como límite físico del cabezal, `@page { margin: 0 }` ya le
      // pide al navegador el mínimo posible, pero no puede pedirle menos de
      // lo que el propio driver dice que el hardware permite.
      setPageHeightMm(Math.max(30, Math.ceil(contentPx / PX_PER_MM) + 4))
    }, 50)
    return () => clearTimeout(timer)
  }, [])

  // Fase 2: recién cuando el alto real ya quedó aplicado al <style> (el
  // `@page` de abajo depende de `pageHeightMm`), se dispara el diálogo de
  // impresión del sistema.
  useEffect(() => {
    if (pageHeightMm == null || printedRef.current) return
    printedRef.current = true
    function handleAfterPrint() {
      onDone()
    }
    window.addEventListener('afterprint', handleAfterPrint)
    // Otro tick para que el navegador termine de aplicar el <style> ya
    // actualizado (con las dos medidas del `@page`) antes de abrir el
    // diálogo -- sin esto se arriesga a capturar el layout a medio commitear.
    const timer = setTimeout(() => window.print(), 30)
    return () => {
      window.removeEventListener('afterprint', handleAfterPrint)
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageHeightMm])

  return createPortal(
    <>
      <style>{`
        @page { size: ${widthMm}mm ${pageHeightMm ?? 200}mm; margin: 0; }
        .pos-receipt-print-portal {
          position: fixed;
          top: 0;
          left: -10000px;
          pointer-events: none;
          box-sizing: border-box;
          width: ${widthMm}mm;
          padding: 0 ${sideMarginMm}mm;
          margin: 0;
          font-family: Arial, Helvetica, sans-serif;
          font-size: ${fontSizePx}px;
          font-weight: 500;
          line-height: 1.45;
          color: #000;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
          /* Nunca partir el ticket en una segunda página -- si el alto
             calculado (arriba) quedara apenas corto por cualquier motivo,
             sin esto el resto se iba a una página nueva, y como la regla
             de @page declara el mismo alto para las dos, esa segunda hoja
             salía casi vacía (una línea + todo el resto en blanco) --
             exactamente el "papel perdido" reportado por el usuario. */
          break-inside: avoid;
          page-break-inside: avoid;
        }
        .pos-receipt-print-portal * { box-sizing: border-box; }
        .pos-receipt-print-portal p { margin: 0; }
        .pos-receipt-header { text-align: center; margin-bottom: 5px; }
        .pos-receipt-business-name { font-weight: 800; font-size: 1.2em; text-transform: uppercase; letter-spacing: 0.2px; }
        .pos-receipt-legal-name { font-size: 0.9em; }
        /* Alto FIJO (no max-height) -- pedido explícito del usuario: el
           logo debe verse más grande que el nombre del negocio. Con
           max-height nomás, un logo de baja resolución se imprimía a su
           tamaño natural (a veces más chico que el propio texto del
           nombre) en vez de ocupar el espacio disponible -- un alto fijo
           fuerza que SIEMPRE ocupe ~90px, escalando hacia arriba si hace
           falta. width:auto + max-width mantienen la proporción y evitan
           que un logo muy apaisado se salga del ticket. */
        .pos-receipt-logo { height: 90px; width: auto; max-width: 85%; object-fit: contain; margin: 0 auto 6px; display: block; }
        .pos-receipt-rule { border-top: 1px dashed #000; margin: 5px 0; }
        .pos-receipt-doc { text-align: center; }
        .pos-receipt-doc-title { font-weight: 800; text-transform: uppercase; }
        .pos-receipt-doc-number { font-weight: 800; font-size: 1.05em; }
        .pos-receipt-meta, .pos-receipt-totals, .pos-receipt-payments { display: flex; flex-direction: column; gap: 2px; }
        .pos-receipt-item { padding: 2px 0; }
        /* Fila etiqueta/valor (MetaRow) e ítem comparten esta estructura
           (flex justify-between gap-2) -- sin min-width:0, un span de
           texto dentro de un flex no se achica ni hace salto de línea: se
           sale del ancho del papel y la impresora térmica lo corta en el
           borde en vez de mostrarlo completo (tanto un nombre de producto
           largo como un nombre de cliente largo en el lado del valor). Se
           lo permite en los dos lados de la fila -- un monto nunca es tan
           largo como para necesitarlo, pero un nombre sí, y es preferible
           que la fila crezca a que el borde se corte. */
        .pos-receipt-print-portal .flex.justify-between { align-items: flex-start; }
        .pos-receipt-print-portal .flex.justify-between > span { min-width: 0; overflow-wrap: break-word; word-break: break-word; padding-left: 4px; }
        .pos-receipt-print-portal .flex.justify-between > span:first-child { padding-left: 0; }
        .pos-receipt-total-line { display: flex; justify-content: space-between; font-weight: 800; font-size: 1.15em; margin-top: 2px; }
        .pos-receipt-fiscal { text-align: center; }
        .pos-receipt-cufe { word-break: break-all; }
        .pos-receipt-qr { display: block; width: 100px; height: 100px; margin: 5px auto; }
        .pos-receipt-footer { text-align: center; margin-top: 6px; font-weight: 600; }
        .pos-receipt-disclaimer { text-align: center; margin-top: 4px; font-size: 0.85em; }
        @media print {
          body > #root { display: none !important; }
          .pos-receipt-print-portal { position: static; left: auto; pointer-events: auto; }
        }
      `}</style>
      <div ref={contentRef} className="pos-receipt-print-portal" aria-hidden="true">
        {children}
      </div>
    </>,
    document.body,
  )
}
