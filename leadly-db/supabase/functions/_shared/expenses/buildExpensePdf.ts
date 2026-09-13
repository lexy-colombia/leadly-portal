/** Comprobante de egreso en PDF -- la contraparte "de archivo" de la tirilla
 * térmica (ExpenseReceiptTicket.tsx).
 *
 * El diseño es EL MISMO de la factura (buildInvoicePdf.ts): A4, Times-Roman
 * en todo el documento, encabezado con logo + datos del negocio a la
 * izquierda y bloque del documento a la derecha, recuadro de datos partido
 * en dos columnas, tabla de ítems con banda de encabezado y recuadro que
 * llega al pie, y bloques de notas + totales lado a lado. Pedido explícito
 * del usuario (2026-09-13): "el diseño del pdf no es el mismo de la factura,
 * quiero que sea así, lo mismo, pero sin la lógica del qr de la parte
 * inferior".
 *
 * Las dos diferencias con la factura son deliberadas:
 * - NO lleva el recuadro de verificación del pie (QR + CUFE): un egreso no
 *   es un documento electrónico validado por la DIAN, así que no hay nada
 *   que verificar. En su lugar va el espacio de firma de quien recibe, que
 *   es lo que convierte el papel en un comprobante de entrega real.
 * - NO lleva numeración autorizada ni responsabilidades tributarias en el
 *   encabezado: un egreso es un documento INTERNO de control, y la leyenda
 *   del pie lo dice explícito. Mismo criterio que `isRemision` en la
 *   factura: nunca aparentar un comprobante que no existe. */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type RGB } from "npm:pdf-lib@1.17.1";

export interface ExpensePdfData {
  tenant: {
    name: string;
    legal_name: string | null;
    document_type: string | null;
    document_number: string | null;
    billing_address: string | null;
    contact_email: string | null;
    contact_phone: string | null;
    country: string | null;
    state_province: string | null;
  };
  expense: {
    number: number;
    amount: number;
    currency: string;
    description: string | null;
    payment_method: string | null;
    status: string;
    expense_date: string;
    payment_date: string | null;
    created_at: string;
    supplier_name: string | null;
    category_name: string | null;
  };
  /** Entradas de inventario cargadas contra este gasto, si las hay -- es el
   * detalle de en qué se convirtió la plata (ver expense_inventory_entries).
   * Sin entradas, la tabla lleva una única línea con el concepto. */
  entries: { product_name: string; quantity: number; unit_cost: number; subtotal: number }[];
  /** Bytes del logo del tenant, ya descargados -- null si no tiene o si la
   * descarga falló: el PDF sale igual, sin logo. */
  logoBytes: Uint8Array | null;
}

const STATUS_LABEL: Record<string, string> = {
  pendiente: "Pendiente",
  pagado: "Pagado",
  anulado: "Anulado",
};

/** Mismo formato que buildInvoicePdf: separador de miles, dos decimales. */
function money(value: number): string {
  return new Intl.NumberFormat("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/** DD/MM/YYYY. Una columna `date` llega como "YYYY-MM-DD": se parte la
 * cadena en vez de pasarla por Date, que la interpretaría como instante UTC
 * y la correría un día (mismo bug corregido en el frontend el 2026-09-12). */
function formatDateEs(iso: string | null): string {
  if (!iso) return "—";
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : iso;
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : ["—"];
}

/** Reduce el cuerpo hasta que el texto quepa en `maxWidth` -- evita que un
 * nombre largo se salga de su columna. */
function fitTextSize(str: string, font: PDFFont, maxWidth: number, startSize: number, minSize = 6): number {
  let size = startSize;
  while (size > minSize && font.widthOfTextAtSize(str, size) > maxWidth) size -= 0.25;
  return size;
}

export async function buildExpensePdf(input: ExpensePdfData): Promise<Uint8Array> {
  const { tenant, expense, entries } = input;
  const pdfDoc = await PDFDocument.create();
  const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4, igual que la factura
  const page = pdfDoc.addPage(PAGE_SIZE);
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const bold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  let logoImage: Awaited<ReturnType<typeof pdfDoc.embedPng>> | null = null;
  if (input.logoBytes) {
    try {
      logoImage = await pdfDoc.embedPng(input.logoBytes);
    } catch {
      try {
        logoImage = await pdfDoc.embedJpg(input.logoBytes);
      } catch {
        logoImage = null;
      }
    }
  }

  const margin = 36;
  const pageWidth = PAGE_SIZE[0];
  const pageHeight = PAGE_SIZE[1];
  const contentWidth = pageWidth - margin * 2;
  const pageTop = pageHeight - margin;
  const black = rgb(0.1, 0.1, 0.12);
  const gray = rgb(0.45, 0.45, 0.48);
  const line = rgb(0.75, 0.75, 0.78);
  const softFill = rgb(0.96, 0.96, 0.97);

  const text = (str: string, x: number, yPos: number, opts: { size?: number; f?: PDFFont; color?: RGB } = {}) =>
    page.drawText(str, { x, y: yPos, size: opts.size ?? 8.5, font: opts.f ?? font, color: opts.color ?? black });
  const rightText = (str: string, xRight: number, yPos: number, opts: { size?: number; f?: PDFFont; color?: RGB } = {}) => {
    const size = opts.size ?? 8.5;
    const f = opts.f ?? font;
    page.drawText(str, { x: xRight - f.widthOfTextAtSize(str, size), y: yPos, size, font: f, color: opts.color ?? black });
  };
  const centerText = (str: string, xCenter: number, yPos: number, opts: { size?: number; f?: PDFFont; color?: RGB } = {}) => {
    const size = opts.size ?? 8.5;
    const f = opts.f ?? font;
    page.drawText(str, { x: xCenter - f.widthOfTextAtSize(str, size) / 2, y: yPos, size, font: f, color: opts.color ?? black });
  };
  const hr = (yPos: number) => page.drawLine({ start: { x: margin, y: yPos }, end: { x: pageWidth - margin, y: yPos }, thickness: 0.75, color: line });

  // ----- Encabezado: mismo reparto que la factura (logo + datos planos a la
  // izquierda; título en serif regular, línea y número a la derecha). -----
  const headerTop = pageTop;
  const rightBlockX = margin + 270;
  const rightBlockW = pageWidth - margin - rightBlockX;
  const rightBlockCenter = rightBlockX + rightBlockW / 2;

  const title = "Comprobante de Egreso";
  centerText(title, rightBlockCenter, headerTop, { size: fitTextSize(title, font, rightBlockW - 8, 13, 9) });
  const titleRuleY = headerTop - 7;
  page.drawLine({ start: { x: rightBlockX, y: titleRuleY }, end: { x: pageWidth - margin, y: titleRuleY }, thickness: 0.75, color: line });
  centerText(`EGR-${expense.number}`, rightBlockCenter, titleRuleY - 14, { size: 11 });
  centerText(`Registrado: ${formatDateEs(expense.created_at)}`, rightBlockCenter, titleRuleY - 27, { size: 6.5, color: gray });
  const rightLastBaseline = titleRuleY - 27;

  const maxLogoW = 75;
  let logoDrawW = 0;
  let logoDrawH = 0;
  if (logoImage) {
    const scale = Math.min((headerTop - rightLastBaseline) / logoImage.height, maxLogoW / logoImage.width);
    logoDrawW = logoImage.width * scale;
    logoDrawH = logoImage.height * scale;
    page.drawImage(logoImage, { x: margin, y: rightLastBaseline, width: logoDrawW, height: logoDrawH });
  }

  const sellerX = logoImage ? margin + logoDrawW + 10 : margin;
  const sellerW = rightBlockX - sellerX - 10;
  const cityCountry = [tenant.state_province, tenant.country].filter(Boolean).join(" - ");
  const sellerLines: string[] = [tenant.legal_name ?? tenant.name];
  if (tenant.document_number) sellerLines.push(`${tenant.document_type ?? "NIT"} ${tenant.document_number}`);
  if (tenant.billing_address) sellerLines.push(...wrapText(tenant.billing_address, font, 7.5, sellerW));
  if (tenant.contact_phone) sellerLines.push(tenant.contact_phone);
  if (tenant.contact_email) sellerLines.push(tenant.contact_email);
  if (cityCountry) sellerLines.push(cityCountry);

  const sellerLeading = 9.5;
  const sellerCapHeight = 5.3;
  let ly = headerTop;
  if (logoImage) {
    const logoCenter = rightLastBaseline + logoDrawH / 2;
    ly = Math.min(headerTop, logoCenter + ((sellerLines.length - 1) * sellerLeading) / 2 - sellerCapHeight / 2);
  }
  for (const l of sellerLines) {
    text(l, sellerX, ly, { size: fitTextSize(l, font, sellerW, 7.5, 6) });
    ly -= sellerLeading;
  }

  let y = Math.min(ly, rightLastBaseline) - 18;

  // ----- Recuadro de datos (mismo que el de cliente + fechas de la
  // factura): a quién se le pagó a la izquierda, cuándo y cómo a la
  // derecha. -----
  const boxLines: string[][] = [
    ["PROVEEDOR:", expense.supplier_name ?? "—"],
    ["CATEGORÍA:", expense.category_name ?? "—"],
    ["MÉTODO DE PAGO:", expense.payment_method ?? "—"],
    ["ESTADO:", STATUS_LABEL[expense.status] ?? expense.status],
  ];
  const rightBoxLines: string[][] = [
    ["Fecha:", formatDateEs(expense.expense_date)],
    ["Fecha de pago:", formatDateEs(expense.payment_date)],
    ["Moneda:", expense.currency],
  ];
  const boxHeight = Math.max(boxLines.length, rightBoxLines.length) * 11.5 + 11;
  page.drawRectangle({ x: margin, y: y - boxHeight, width: contentWidth, height: boxHeight, borderColor: line, borderWidth: 0.75 });
  page.drawLine({ start: { x: margin + contentWidth * 0.6, y }, end: { x: margin + contentWidth * 0.6, y: y - boxHeight }, thickness: 0.75, color: line });

  let by = y - 13;
  for (const [label, value] of boxLines) {
    text(label, margin + 8, by, { size: 7.5, f: bold });
    text(value, margin + 92, by, { size: 7.5 });
    by -= 11.5;
  }
  let rby = y - 13;
  const rightBoxX = margin + contentWidth * 0.6 + 10;
  for (const [label, value] of rightBoxLines) {
    text(label, rightBoxX, rby, { size: 7.5, f: bold });
    text(value, rightBoxX + 68, rby, { size: 7.5 });
    rby -= 11.5;
  }
  y = y - boxHeight - 15;

  // ----- Tabla: las entradas de inventario del gasto o, si no hay ninguna,
  // una única línea con el concepto -- la tabla nunca queda vacía. -----
  const rows = entries.length > 0
    ? entries.map((e) => ({ desc: e.product_name, qty: e.quantity, unit: e.unit_cost, total: e.subtotal }))
    : [{ desc: expense.description ?? expense.category_name ?? "Egreso", qty: 1, unit: expense.amount, total: expense.amount }];

  const cols = [
    { key: "desc", label: "Descripción", x: margin, w: 330 },
    { key: "qty", label: "Cant", x: margin + 330, w: 50 },
    { key: "unit", label: "Unitario", x: margin + 380, w: 70 },
    { key: "total", label: "Total", x: margin + 450, w: contentWidth - 450 },
  ];

  const measured = rows.map((r) => {
    const descLines = wrapText(r.desc, font, 7.5, cols[0].w - 6);
    return { row: r, descLines, h: Math.max(1, descLines.length) * 9.5 + 4 };
  });

  // Bloques de resumen (notas + totales) y firma: se reservan ANTES de
  // decidir hasta dónde baja el recuadro de la tabla, igual que la factura
  // reserva el pie de verificación.
  const totalsBoxW = 210;
  const totalsBoxX = pageWidth - margin - totalsBoxW;
  const totalsRows: [string, string, boolean?][] = [
    ["Subtotal", money(expense.amount)],
    ["Total", money(expense.amount), true],
    ["Ítems", String(rows.length)],
    ["Moneda", expense.currency],
  ];
  const totalsH = totalsRows.length * 11.5 + 9;

  const notesBoxX = margin;
  const notesBoxW = totalsBoxX - 10 - margin;
  const noteLines = expense.description ? wrapText(expense.description, font, 7.5, notesBoxW - 16) : [];
  const notesH = noteLines.length > 0 ? noteLines.length * 10.5 + 20 : 0;
  const summaryH = Math.max(totalsH, notesH);
  const signatureH = 78;
  const footerH = 16;

  const tableTop = y;
  const tableBottom = margin + footerH + signatureH + summaryH + 18;

  page.drawRectangle({ x: margin, y: tableTop - 13, width: contentWidth, height: 13, color: softFill });
  for (const c of cols) {
    if (c.key === "desc") text(c.label, c.x + 3, tableTop - 9.5, { size: 7, f: bold });
    else rightText(c.label, c.x + c.w, tableTop - 9.5, { size: 7, f: bold });
  }
  let ry = tableTop - 13;
  hr(ry);
  for (const m of measured) {
    m.descLines.forEach((l, idx) => text(l, cols[0].x + 3, ry - 10.5 - idx * 9.5, { size: 7.5 }));
    rightText(m.row.qty.toFixed(2), cols[1].x + cols[1].w, ry - 10.5, { size: 7 });
    rightText(money(m.row.unit), cols[2].x + cols[2].w, ry - 10.5, { size: 7 });
    rightText(money(m.row.total), cols[3].x + cols[3].w, ry - 10.5, { size: 7 });
    ry -= m.h;
    hr(ry);
  }
  // El recuadro llega hasta donde empieza el resumen, no hasta la última
  // fila -- mismo criterio que la factura, para no dejar media hoja vacía.
  page.drawRectangle({ x: margin, y: tableBottom, width: contentWidth, height: tableTop - tableBottom, borderColor: line, borderWidth: 0.75 });

  // ----- Notas (concepto) + Totales, lado a lado. -----
  const summaryTop = tableBottom - 12;
  if (noteLines.length > 0) {
    page.drawRectangle({ x: notesBoxX, y: summaryTop - notesH, width: notesBoxW, height: notesH, borderColor: line, borderWidth: 0.75 });
    text("Concepto", notesBoxX + 8, summaryTop - 12, { size: 7.5, f: bold });
    let ny = summaryTop - 25;
    for (const l of noteLines) {
      text(l, notesBoxX + 8, ny, { size: 7.5 });
      ny -= 10.5;
    }
  }
  page.drawRectangle({ x: totalsBoxX, y: summaryTop - totalsH, width: totalsBoxW, height: totalsH, color: softFill, borderColor: line, borderWidth: 0.75 });
  let ty = summaryTop - 12;
  for (const [label, value, emphasis] of totalsRows) {
    text(label, totalsBoxX + 8, ty, { size: emphasis ? 8.5 : 7.5, f: emphasis ? bold : font });
    rightText(value, totalsBoxX + totalsBoxW - 8, ty, { size: emphasis ? 8.5 : 7.5, f: emphasis ? bold : font });
    ty -= 11.5;
  }

  // ----- Firma: acá va, en vez del recuadro de verificación con QR de la
  // factura. Es lo que hace del papel un comprobante de entrega. -----
  const signTop = summaryTop - summaryH - 16;
  const signBoxW = (contentWidth - 16) / 2;
  for (const [idx, label] of ["Entregado por", "Recibí conforme"].entries()) {
    const x = margin + idx * (signBoxW + 16);
    page.drawLine({ start: { x, y: signTop - 34 }, end: { x: x + signBoxW, y: signTop - 34 }, thickness: 0.75, color: line });
    text(label, x, signTop - 45, { size: 7, f: bold });
    text("Nombre y documento", x, signTop - 55, { size: 6.5, color: gray });
  }

  text("Documento interno de control. No es una factura.", margin, margin, { size: 6.5, color: gray });
  rightText(`${tenant.name} · EGR-${expense.number}`, pageWidth - margin, margin, { size: 6.5, color: gray });

  return await pdfDoc.save();
}
