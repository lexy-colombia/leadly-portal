import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import type { PosReceiptData } from '../../lib/api/posReceipt'
import { PosReceiptTicket } from './PosReceiptTicket'

/** Imprime UN ticket a la vez: se monta con los datos ya cargados, dispara
 * el diálogo de impresión del sistema apenas termina de pintar (sin
 * esperar a que el logo cargue -- una imagen que tarda no debe trabar el
 * cobro), y se desmonta solo cuando el diálogo se cierra (se imprima o se
 * cancele). Nunca imprime en silencio -- ver el comentario de la migración
 * 20260904190000 sobre por qué eso requeriría un agente local aparte.
 *
 * Truco de "imprimir solo esto": el contenido se monta vía createPortal
 * directo en document.body (hermano de #root, no un hijo), y el <style>
 * global inyectado acá mismo hace `display:none` sobre #root y muestra
 * únicamente el ticket -- así no hace falta ningún iframe ni ventana
 * aparte, y el resto de la SPA (React) sigue vivo e intacto detrás. */
export function ReceiptPrintPortal({ data, paperWidth, onDone }: { data: PosReceiptData; paperWidth: '58mm' | '80mm'; onDone: () => void }) {
  const printedRef = useRef(false)

  useEffect(() => {
    function handleAfterPrint() {
      onDone()
    }
    window.addEventListener('afterprint', handleAfterPrint)
    // Un tick para que el navegador termine de pintar el ticket antes de
    // abrir el diálogo -- sin esto, algunos navegadores capturan el layout
    // a medio construir.
    const timer = setTimeout(() => {
      if (printedRef.current) return
      printedRef.current = true
      window.print()
    }, 50)
    return () => {
      window.removeEventListener('afterprint', handleAfterPrint)
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const widthMm = paperWidth === '58mm' ? 58 : 80

  return createPortal(
    <>
      <style>{`
        @page { size: ${widthMm}mm auto; margin: 0; }
        .pos-receipt-print-portal { display: none; }
        @media print {
          body > #root { display: none !important; }
          .pos-receipt-print-portal {
            display: block !important;
            width: ${widthMm}mm;
            margin: 0;
            font-family: 'Courier New', monospace;
            font-size: ${widthMm === 58 ? '10px' : '11px'};
            line-height: 1.35;
            color: #000;
          }
          .pos-receipt-print-portal p { margin: 0; }
          .pos-receipt-header { text-align: center; margin-bottom: 4px; }
          .pos-receipt-business-name { font-weight: 700; font-size: 1.15em; text-transform: uppercase; }
          .pos-receipt-logo { max-width: 60%; max-height: 40px; margin: 0 auto 4px; display: block; }
          .pos-receipt-rule { border-top: 1px dashed #000; margin: 4px 0; }
          .pos-receipt-doc { text-align: center; }
          .pos-receipt-doc-title { font-weight: 700; text-transform: uppercase; }
          .pos-receipt-doc-number { font-weight: 700; font-size: 1.05em; }
          .pos-receipt-meta, .pos-receipt-totals, .pos-receipt-payments { display: flex; flex-direction: column; gap: 1px; }
          .pos-receipt-item { padding: 1px 0; }
          .pos-receipt-total-line { display: flex; justify-content: space-between; font-weight: 700; font-size: 1.1em; }
          .pos-receipt-fiscal { text-align: center; }
          .pos-receipt-cufe { word-break: break-all; }
          .pos-receipt-qr { display: block; width: 90px; height: 90px; margin: 4px auto; }
          .pos-receipt-footer { text-align: center; margin-top: 4px; }
          .pos-receipt-disclaimer { text-align: center; margin-top: 4px; font-size: 0.85em; }
        }
      `}</style>
      <div className="pos-receipt-print-portal">
        <PosReceiptTicket data={data} />
      </div>
    </>,
    document.body,
  )
}
