/** Representación gráfica (PDF) de una factura DIAN -- lo que un cliente
 * real puede ver/imprimir, a diferencia del CUFE (un hash de 96 caracteres
 * que no le sirve a un humano para nada por sí solo). Pedido explícito del
 * usuario 2026-09-03, con un ejemplo real de factura (de otro software de
 * facturación, mismo tenant "Barriles de la sexta") como referencia de
 * layout: encabezado con datos del vendedor + numeración autorizada,
 * bloque de cliente + fechas, tabla de ítems, totales, y CUFE + QR de
 * verificación al pie.
 *
 * Deliberadamente NO es un clon pixel-perfect del ejemplo (pdf-lib dibuja
 * con coordenadas manuales, no HTML/CSS) -- reproduce la misma estructura
 * e información, no la tipografía exacta.
 *
 * El QR codifica la URL pública de verificación del catálogo de la DIAN
 * (`https://catalogo-vpfe[-hab].dian.gov.co/document/searchqr?documentkey=<CUFE>`)
 * -- confirmado contra el ejemplo real que trajo el usuario, mismo formato
 * que usa cualquier software de facturación electrónica colombiano.
 *
 * Se genera on-demand en cada descarga (no se cachea en Storage) -- una
 * factura de este tamaño renderiza en milisegundos, no vale la pena la
 * complejidad de un bucket/columna nueva para esto todavía. */
import { PDFDocument, StandardFonts, rgb, type PDFFont, type RGB } from "npm:pdf-lib@1.17.1";
import QRCode from "npm:qrcode@1.5.4";

export interface InvoicePdfBuyer {
  full_name: string | null;
  document_type_code: string | null;
  document_number: string | null;
  phone: string | null;
  email: string | null;
  address: { line1: string | null; line2: string | null; city: string | null; state_province: string | null; country: string | null } | null;
}

export interface InvoicePdfSeller {
  legal_name: string | null;
  document_type: string | null;
  document_number: string | null;
  city: string | null;
  billing_address: string | null;
  country: string | null;
  state_province: string | null;
  fiscal_regime: string | null;
  is_self_withholding_agent: boolean;
  resolution: { number: string | null; prefix: string | null; range_from: number | null; range_to: number | null; valid_from: string | null; valid_until: string | null } | null;
  contact_email: string | null;
  contact_phone: string | null;
}

export interface InvoicePdfItem {
  product_name: string;
  sku: string | null;
  quantity: number;
  unit_price: number;
  subtotal: number;
  tax_type_code: string | null;
  tax_rate: number;
  tax_amount: number;
}

export interface BuildInvoicePdfInput {
  status: string;
  statusDetail: string | null;
  invoicePrefix: string | null;
  invoiceNumber: number | null;
  issueDate: string | null;
  cufe: string | null;
  currency: string;
  subtotal: number;
  taxTotal: number;
  withholdingTotal: number;
  total: number;
  buyer: InvoicePdfBuyer;
  seller: InvoicePdfSeller;
  items: InvoicePdfItem[];
  orderNumber: number;
  orderCreatedAt: string;
  paymentMethodLabel: string | null;
  qrVerificationUrl: string | null;
  /** Remisión: el tenant NO tiene facturación electrónica DIAN
   * configurada, así que este documento no es una factura fiscal. Cambia el
   * título y el prefijo del número (REM), y se omiten resolución, CUFE y QR
   * -- pero el espacio que ocupaban se respeta, para que el documento tenga
   * exactamente la misma silueta que una factura (pedido explícito del
   * usuario 2026-09-04: "lo demás desaparece y se deja el espacio en blanco
   * para que quede igual"). */
  isRemision: boolean;
  /** Comentarios del pedido que van impresos en la factura, en orden
   * cronológico. Son los del hilo "Comentarios" (sales_order_comments con
   * is_internal = false) -- las "Notas" internas NUNCA llegan acá: son para
   * el equipo, no para el cliente ni para la DIAN. */
  notes: string[];
  /** Bytes crudos del logo del tenant (tenants.logo_url, bucket público
   * tenant-logos) -- null si el tenant no cargó uno, o si no se pudo
   * descargar (nunca bloquea la generación del PDF por esto). */
  logoBytes: Uint8Array | null;
}

/** Mismo identificador que se ve en el encabezado ("POS-3393") -- prefijo de
 * la resolución + el consecutivo DIAN si ya se envió, o el número del
 * pedido mientras no haya uno asignado todavía (para que la factura tenga
 * SIEMPRE una etiqueta legible con la misma forma, en vez de un texto
 * distinto tipo "Pedido #2 (sin numerar)" -- pedido explícito del usuario
 * 2026-09-03, con una factura real de otro software como referencia:
 * "el nombre del archivo debe ser el prefijo y el número... tal cual como
 * está el header de esta factura"). Ojo: es solo para mostrar/nombrar el
 * archivo -- el identificador técnico real que exige la DIAN (sin guion,
 * usado en el CUFE) sigue viviendo aparte en sendInvoiceToDian.ts, esto no
 * lo toca. */
export function invoiceDisplayLabel(prefix: string | null, invoiceNumber: number | null, orderNumber: number): string {
  const num = invoiceNumber ?? orderNumber;
  return prefix ? `${prefix}-${num}` : String(num);
}

const TAX_TYPE_LABEL: Record<string, string> = { "01": "IVA", "02": "IC", "03": "ICA", "04": "INC" };

function money(value: number): string {
  return new Intl.NumberFormat("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

function formatDateEs(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

/** Envuelve texto a un ancho máximo (en puntos) para el font/size dados --
 * pdf-lib no hace wrap automático. */
function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const w of text.split(/\s+/)) {
    const candidate = current ? `${current} ${w}` : w;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (font.widthOfTextAtSize(w, size) <= maxWidth) {
      current = w;
      continue;
    }
    // Una sola "palabra" más ancha que la columna entera (un CUFE de 96
    // caracteres, la URL de verificación de la DIAN, un SKU sin espacios) no
    // se puede cortar por espacios porque no tiene ninguno -- se parte por
    // caracteres. Sin esto se dibujaba en una única línea que se derramaba
    // sobre la columna vecina o fuera del margen de la página (bug real: la
    // URL del catálogo DIAN pasaba por encima del QR y se salía de la hoja).
    let chunk = "";
    for (const ch of w) {
      if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    current = chunk;
  }
  if (current) lines.push(current);
  return lines;
}

/** "Shrink to fit" -- reduce el tamaño hasta que el texto entre en UNA sola
 * línea dentro de maxWidth (nunca por debajo de minSize), mismo criterio
 * que una columna de Excel achicando la fuente en vez de derramar el texto
 * sobre la columna de al lado. Antes el nombre del vendedor se dibujaba
 * siempre al tamaño fijo sin chequear su ancho real -- una razón social
 * larga invadía la columna del título (bug real reportado por el usuario,
 * 2026-09-03). Se usa para textos que deben quedar en una sola línea
 * (nombre del vendedor, título); las direcciones siguen usando wrapText
 * (varias líneas es lo esperado ahí). */
function fitTextSize(str: string, font: PDFFont, maxWidth: number, startSize: number, minSize = 7): number {
  let size = startSize;
  while (size > minSize && font.widthOfTextAtSize(str, size) > maxWidth) size -= 0.5;
  return size;
}

export async function buildInvoicePdf(input: BuildInvoicePdfInput): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const PAGE_SIZE: [number, number] = [595.28, 841.89]; // A4
  // `page` es mutable: los helpers de dibujo (text/rightText/hr/...) lo leen
  // del closure en cada llamada, así que reasignarlo al agregar una página
  // redirige todo el dibujo a la nueva sin tener que pasarla por parámetro.
  let page = pdfDoc.addPage(PAGE_SIZE);
  // Times-Roman en todo el documento -- pedido explícito del usuario
  // 2026-09-03 tras comparar con una factura real de referencia (serif
  // clásico, no el sans-serif que se usaba antes) por verse "mejor para
  // una factura". Antes solo el título usaba serif y el resto Helvetica.
  const font = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const bold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);

  // Logo del tenant -- nunca bloquea la generación si falta o no se puede
  // decodificar (PNG es lo que sube el formulario de Configuración, pero se
  // intenta JPG como respaldo por si acaso).
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

  function text(str: string, x: number, yPos: number, opts: { size?: number; f?: PDFFont; color?: RGB } = {}) {
    page.drawText(str, { x, y: yPos, size: opts.size ?? 8.5, font: opts.f ?? font, color: opts.color ?? black });
  }

  function rightText(str: string, xRight: number, yPos: number, opts: { size?: number; f?: PDFFont; color?: RGB } = {}) {
    const size = opts.size ?? 8.5;
    const f = opts.f ?? font;
    const w = f.widthOfTextAtSize(str, size);
    page.drawText(str, { x: xRight - w, y: yPos, size, font: f, color: opts.color ?? black });
  }

  function centerText(str: string, xCenter: number, yPos: number, opts: { size?: number; f?: PDFFont; color?: RGB } = {}) {
    const size = opts.size ?? 8.5;
    const f = opts.f ?? font;
    const w = f.widthOfTextAtSize(str, size);
    page.drawText(str, { x: xCenter - w / 2, y: yPos, size, font: f, color: opts.color ?? black });
  }

  function hr(yPos: number) {
    page.drawLine({ start: { x: margin, y: yPos }, end: { x: pageWidth - margin, y: yPos }, thickness: 0.75, color: line });
  }

  // Una factura que no está 'sent'/'accepted' NO es todavía un documento
  // fiscal válido (pendiente de envío, o rechazada por la DIAN). Antes eso
  // se avisaba con un banner ámbar al tope de la página; ahora se explica en
  // el recuadro de verificación del pie, junto al CUFE que le corresponde
  // (pedido explícito del usuario 2026-09-03: "quita eso de documento
  // fallido... no así con alerta, debe ser más profesional").
  const isValidated = input.status === "sent" || input.status === "accepted";

  // ----- Encabezado, calcado de la factura de referencia que trajo el
  // usuario (2026-09-03, "quiero que el header se vea exactamente como el
  // de esta factura de referencia, no más, no menos"): logo + datos del
  // vendedor como una lista plana a la izquierda; a la derecha -- que
  // arranca poco después de la mitad de la hoja, no en el último tercio --
  // título en serif regular + línea separadora + número, y debajo dos
  // sub-columnas: numeración autorizada (con rótulo en negrita) y
  // responsabilidades (SIN rótulo, sus líneas arrancan a la misma altura
  // que el de la izquierda, tal cual la referencia). Sin línea horizontal
  // de cierre al pie del encabezado -- la referencia no la tiene, separa
  // del recuadro de cliente solo con aire.
  //
  // Se dibuja en TODA página del documento (devuelve la `y` donde termina),
  // no solo en la primera: una factura de varias hojas tiene que poder
  // leerse hoja por hoja sin perder de vista de quién es y qué número tiene.
  // -----
  function drawHeader(): number {
  const headerTop = pageTop;
  const rightBlockX = margin + 270;
  const rightBlockW = pageWidth - margin - rightBlockX;

  // La columna DERECHA se dibuja primero a propósito: su última fila (la de
  // RESOLUCIÓN) es la que define hasta dónde baja el encabezado, y por lo
  // tanto el alto del logo -- ver el bloque del logo más abajo. El orden de
  // dibujo no afecta el resultado (no se superponen), solo el orden en que
  // se calculan las coordenadas.
  //
  // Título en serif REGULAR, no negrita -- en la referencia es una
  // tipografía liviana, ése es justamente el rasgo que la hace ver de
  // factura formal. "Shrink to fit" para que un tenant con nombre largo
  // nunca produzca un título que se salga de su columna.
  const rightBlockCenter = rightBlockX + rightBlockW / 2;
  const titleText = input.isRemision ? "Remisión" : "Factura Electrónica de Venta";
  centerText(titleText, rightBlockCenter, headerTop, { size: fitTextSize(titleText, font, rightBlockW - 8, 13, 9) });
  const titleRuleY = headerTop - 7;
  page.drawLine({ start: { x: rightBlockX, y: titleRuleY }, end: { x: pageWidth - margin, y: titleRuleY }, thickness: 0.75, color: line });
  const invoiceLabel = invoiceDisplayLabel(input.seller.resolution?.prefix ?? input.invoicePrefix, input.invoiceNumber, input.orderNumber);
  centerText(invoiceLabel, rightBlockCenter, titleRuleY - 14, { size: 11 });

  // Las dos sub-columnas arrancan en la MISMA línea base -- la de la
  // derecha no tiene rótulo propio en la referencia, así que su primera
  // línea queda a la altura de "NUMERACIÓN AUTORIZADA".
  const subTop = titleRuleY - 29;
  const numSubX = rightBlockX;
  const numSubW = rightBlockW * 0.585;
  const regimeSubX = rightBlockX + numSubW;
  const regimeSubW = rightBlockW - numSubW;

  let ry = subTop;
  if (input.seller.resolution?.number) {
    text("NUMERACIÓN AUTORIZADA", numSubX, ry, { size: 6.5, f: bold });
    ry -= 8.5;
    if (input.seller.resolution.range_from != null && input.seller.resolution.range_to != null) {
      const prefix = input.seller.resolution.prefix ?? "";
      for (const l of wrapText(`DEL ${prefix}-${input.seller.resolution.range_from} AL ${prefix}-${input.seller.resolution.range_to}`, font, 6.5, numSubW)) {
        text(l, numSubX, ry, { size: 6.5 });
        ry -= 8.5;
      }
    }
    if (input.seller.resolution.valid_from && input.seller.resolution.valid_until) {
      // DESDE y HASTA son un rango, van en la misma fila igual que en la
      // referencia -- "shrink to fit" para que quepan en una sola línea sin
      // importar el ancho de las fechas.
      const validityLine = `DESDE: ${input.seller.resolution.valid_from} HASTA: ${input.seller.resolution.valid_until}`;
      text(validityLine, numSubX, ry, { size: fitTextSize(validityLine, font, numSubW, 6.5, 5.5) });
      ry -= 8.5;
    }
    const resolutionLine = `RESOLUCIÓN: ${input.seller.resolution.number}`;
    text(resolutionLine, numSubX, ry, { size: fitTextSize(resolutionLine, font, numSubW, 6.5, 5.5) });
    ry -= 8.5;
  }
  // Responsabilidades tributarias -- códigos reales del catálogo de la DIAN
  // (RUT / Anexo Técnico de facturación electrónica, campo
  // AdditionalAccountID del UBL): O-48 responsable de IVA, O-49 no
  // responsable, O-15 autorretenedor. Solo se listan las que el tenant
  // configuró de verdad en su perfil DIAN -- nunca se fabrica un negativo
  // tipo "No somos X" para una responsabilidad que no se preguntó (pedido
  // explícito del usuario 2026-09-03: "todos los datos del header salen de
  // lo que el tenant cargue allí"), aunque la referencia sí los liste.
  // Gran contribuyente (O-13) y actividad económica CIIU tampoco se
  // muestran -- tenant_dian_profile no las modela todavía, y no hay de
  // dónde sacarlas sin inventarlas.
  const regimeLines: string[] = [];
  if (input.seller.fiscal_regime === "responsable_iva") regimeLines.push("O-48 Responsable de IVA");
  else if (input.seller.fiscal_regime === "no_responsable_iva") regimeLines.push("O-49 No responsable de IVA");
  if (input.seller.is_self_withholding_agent) regimeLines.push("O-15 Autorretenedor");

  let rry = subTop;
  for (const l of regimeLines) {
    text(l, regimeSubX, rry, { size: fitTextSize(l, font, regimeSubW, 6.5, 5.5) });
    rry -= 8.5;
  }

  // Línea base de la ÚLTIMA fila dibujada del bloque derecho (la de
  // RESOLUCIÓN, salvo que el tenant no tenga resolución cargada). `ry`/`rry`
  // ya quedaron un interlineado por debajo de esa fila, de ahí el +8.5.
  // En una remisión el bloque de numeración no se dibuja, pero se reserva su
  // alto (rótulo + DEL/AL + DESDE/HASTA + RESOLUCIÓN = 4 filas) para que el
  // encabezado mida lo mismo que en una factura -- si no, el logo, que se
  // estira hasta esta línea, saldría más chico y el documento tendría otra
  // silueta ("se deja el espacio en blanco para que quede igual").
  const rightLastBaseline = input.isRemision
    ? subTop - 3 * 8.5
    : Math.min(ry, rry) < subTop
    ? Math.min(ry, rry) + 8.5
    : subTop;

  // ----- Columna izquierda: logo + datos del vendedor -----
  // El logo se escala para que su BASE quede exactamente en esa última fila
  // de la resolución (pedido explícito del usuario 2026-09-03: "la imagen
  // debe estar alineada a las filas de la resolución... alineemos a la
  // última fila para que la imagen vaya también hasta allí"). Antes tenía un
  // alto fijo de 56pt que no se relacionaba con nada del resto del
  // encabezado, así que su borde inferior caía en cualquier lado según el
  // aspecto del logo de cada tenant. El ancho se topa aparte para que un
  // logo muy apaisado no se coma la columna de datos del vendedor -- en ese
  // caso queda más bajo que la fila objetivo, pero nunca desalineado (la
  // base sigue apoyada en `rightLastBaseline`).
  const maxLogoW = 75;
  let logoDrawW = 0;
  let logoDrawH = 0;
  if (logoImage) {
    const scale = Math.min((headerTop - rightLastBaseline) / logoImage.height, maxLogoW / logoImage.width);
    logoDrawW = logoImage.width * scale;
    logoDrawH = logoImage.height * scale;
    page.drawImage(logoImage, { x: margin, y: rightLastBaseline, width: logoDrawW, height: logoDrawH });
  }
  // En la referencia la razón social NO va en negrita ni más grande que el
  // resto del bloque: es una lista plana, todas las líneas al mismo peso y
  // tamaño (nombre, NIT, dirección, correo, ciudad - país, en ese orden).
  const sellerX = logoImage ? margin + logoDrawW + 10 : margin;
  const sellerW = rightBlockX - sellerX - 10;
  const cityCountry = [input.seller.city, input.seller.country].filter(Boolean).join(" - ");
  const sellerLines: string[] = [input.seller.legal_name ?? "—"];
  if (input.seller.document_number) sellerLines.push(`NIT ${input.seller.document_number}`);
  if (input.seller.billing_address) sellerLines.push(...wrapText(input.seller.billing_address, font, 7.5, sellerW));
  if (input.seller.contact_email) sellerLines.push(input.seller.contact_email);
  if (cityCountry) sellerLines.push(cityCountry);

  // El bloque de datos va centrado verticalmente CONTRA EL LOGO, no pegado
  // al tope del encabezado (pedido explícito del usuario 2026-09-03: "los
  // datos del tenant centrados en la imagen, no alineados a la parte
  // superior... con eso no da la sensación de que está desalineado"). Antes
  // ambos arrancaban en `headerTop` y, al tener alturas distintas, el
  // desfase de sus bordes inferiores se leía como un error de alineación.
  // Sin logo no hay contra qué centrar, así que se mantiene arriba; y si el
  // bloque llegara a ser más alto que el logo, se topa en `headerTop` para
  // no invadir lo que haya encima.
  const sellerLeading = 9.5;
  const sellerCapHeight = 5.3; // altura de mayúscula aprox. a 7.5pt en Times
  let ly = headerTop;
  if (logoImage) {
    const logoCenter = rightLastBaseline + logoDrawH / 2;
    ly = Math.min(headerTop, logoCenter + ((sellerLines.length - 1) * sellerLeading) / 2 - sellerCapHeight / 2);
  }
  for (const l of sellerLines) {
    text(l, sellerX, ly, { size: fitTextSize(l, font, sellerW, 7.5, 6) });
    ly -= sellerLeading;
  }

  return Math.min(ly, ry, rry) - 18;
  }

  // ----- Bloque cliente + fechas (recuadro con línea vertical al centro) --
  // Solo en la primera hoja: identifica el documento entero, repetirlo en
  // cada página sería ruido. -----
  function drawClientBox(boxTop: number): number {
  const boxLines = [
    ["CLIENTE:", input.buyer.full_name ?? "Consumidor final"],
    // Solo el número -- el código del tipo de documento (ej. "13") no le
    // dice nada a un humano leyendo la factura, pedido explícito del
    // usuario 2026-09-04.
    ["DOCUMENTO:", input.buyer.document_number ?? "—"],
    ["TELÉFONO:", input.buyer.phone ?? "—"],
    ["DIRECCIÓN:", input.buyer.address ? [input.buyer.address.line1, input.buyer.address.city, input.buyer.address.country].filter(Boolean).join(", ") : "—"],
  ]
  const rightBoxLines: string[][] = [
    // "Fecha" y no "Venta" -- pedido explícito del usuario 2026-09-04, para
    // los dos tipos de documento por igual.
    ["Fecha:", formatDateEs(input.orderCreatedAt)],
  ]
  // "Expedición" es la fecha en que la DIAN recibió el documento: en una
  // remisión no existe ese concepto, así que la fila no se dibuja.
  if (!input.isRemision) rightBoxLines.push(["Expedición:", isValidated ? formatDateEs(input.issueDate) : "Pendiente"])
  rightBoxLines.push(["Método de pago:", input.paymentMethodLabel ?? "—"])
  // Mismo cuerpo de texto (7.5pt) e interlineado proporcional que el bloque
  // del vendedor en el encabezado, para que todo el documento lea en una
  // sola escala tipográfica.
  const boxHeight = Math.max(boxLines.length, rightBoxLines.length) * 11.5 + 11;
  page.drawRectangle({ x: margin, y: boxTop - boxHeight, width: contentWidth, height: boxHeight, borderColor: line, borderWidth: 0.75 });
  page.drawLine({ start: { x: margin + contentWidth * 0.6, y: boxTop }, end: { x: margin + contentWidth * 0.6, y: boxTop - boxHeight }, thickness: 0.75, color: line });

  let by = boxTop - 13;
  for (const [label, value] of boxLines) {
    text(label, margin + 8, by, { size: 7.5, f: bold });
    text(value, margin + 62, by, { size: 7.5 });
    by -= 11.5;
  }
  let rby = boxTop - 13;
  const rightBoxX = margin + contentWidth * 0.6 + 10;
  for (const [label, value] of rightBoxLines) {
    text(label, rightBoxX, rby, { size: 7.5, f: bold });
    text(value, rightBoxX + 62, rby, { size: 7.5 });
    rby -= 11.5;
  }

  return boxTop - boxHeight - 15;
  }

  // ----- Tabla de ítems -----
  const taxCode = input.items.find((i) => i.tax_type_code)?.tax_type_code ?? null;
  const taxLabel = taxCode ? (TAX_TYPE_LABEL[taxCode] ?? "IMP") : "IMP";
  const cols = [
    { key: "code", label: "Código", x: margin, w: 90 },
    { key: "desc", label: "Descripción", x: margin + 90, w: 220 },
    { key: "qty", label: "Cant", x: margin + 310, w: 40 },
    { key: "tax", label: `% ${taxLabel}`, x: margin + 350, w: 45 },
    { key: "unit", label: "Unitario", x: margin + 395, w: 65 },
    { key: "total", label: "Total", x: margin + 460, w: contentWidth - 460 },
  ];

  // Se miden TODAS las filas antes de dibujar nada: el reparto en páginas
  // necesita saber el alto de cada una (una descripción o un SKU largos
  // ocupan varias líneas), y la última página además tiene que reservar el
  // bloque de totales.
  const measured = input.items.map((item) => {
    const descLines = wrapText(item.product_name, font, 7.5, cols[1].w - 6);
    const skuLines = wrapText(item.sku ?? "—", font, 7, cols[0].w - 6);
    return { item, descLines, skuLines, h: Math.max(1, descLines.length, skuLines.length) * 9.5 + 4 };
  });

  function drawTable(top: number, bottom: number, rows: typeof measured) {
    page.drawRectangle({ x: margin, y: top - 13, width: contentWidth, height: 13, color: softFill });
    for (const c of cols) {
      if (c.key === "qty" || c.key === "tax" || c.key === "unit" || c.key === "total") rightText(c.label, c.x + c.w, top - 9.5, { size: 7, f: bold });
      else text(c.label, c.x + 3, top - 9.5, { size: 7, f: bold });
    }
    let ry = top - 13;
    hr(ry);
    for (const r of rows) {
      r.skuLines.forEach((l, idx) => text(l, cols[0].x + 3, ry - 10.5 - idx * 9.5, { size: 7 }));
      r.descLines.forEach((l, idx) => text(l, cols[1].x + 3, ry - 10.5 - idx * 9.5, { size: 7.5 }));
      rightText(r.item.quantity.toFixed(2), cols[2].x + cols[2].w, ry - 10.5, { size: 7 });
      rightText(r.item.tax_rate.toFixed(2), cols[3].x + cols[3].w, ry - 10.5, { size: 7 });
      rightText(money(r.item.unit_price), cols[4].x + cols[4].w, ry - 10.5, { size: 7 });
      rightText(money(r.item.subtotal), cols[5].x + cols[5].w, ry - 10.5, { size: 7 });
      ry -= r.h;
      hr(ry);
    }
    // El recuadro se estira hasta el límite inferior de la página, no hasta
    // donde terminó la última fila -- así llega siempre al pie igual que en
    // la factura de referencia, en vez de cortarse arriba dejando media hoja
    // en blanco (pedido explícito del usuario 2026-09-03).
    page.drawRectangle({ x: margin, y: bottom, width: contentWidth, height: top - bottom, borderColor: line, borderWidth: 0.75 });
  }

  // ----- Notas + Totales, lado a lado -----
  // Mismo par de bloques que la factura de referencia ("Notas" a la
  // izquierda, "Totales" a la derecha). Las notas son los comentarios del
  // pedido; sin comentarios no se dibuja el bloque, para no dejar un
  // recuadro vacío colgando.
  const totalsBoxW = 210;
  const totalsBoxX = pageWidth - margin - totalsBoxW;
  const totalsRows: [string, string, boolean?][] = [["Subtotal", money(input.subtotal)]];
  if (input.taxTotal > 0) totalsRows.push([`Impuestos (${taxLabel})`, money(input.taxTotal)]);
  if (input.withholdingTotal > 0) totalsRows.push(["Retenciones", `-${money(input.withholdingTotal)}`]);
  totalsRows.push(["Total", money(input.total), true]);
  totalsRows.push(["Ítems totales", String(input.items.length)]);
  totalsRows.push(["Moneda", input.currency]);
  const totalsH = totalsRows.length * 11.5 + 9;

  const notesBoxX = margin;
  const notesBoxW = totalsBoxX - 10 - margin;
  const noteLinesFlat = input.notes.flatMap((n) => wrapText(n, font, 7.5, notesBoxW - 16));
  const notesH = noteLinesFlat.length > 0 ? noteLinesFlat.length * 10.5 + 20 : 0;
  // Lo que hay que reservar entre la tabla y el pie: el más alto de los dos.
  const summaryH = Math.max(totalsH, notesH);

  function drawSummary(top: number) {
    if (noteLinesFlat.length > 0) {
      page.drawRectangle({ x: notesBoxX, y: top - notesH, width: notesBoxW, height: notesH, borderColor: line, borderWidth: 0.75 });
      text("Notas", notesBoxX + 8, top - 12, { size: 7.5, f: bold });
      let ny = top - 25;
      for (const l of noteLinesFlat) {
        text(l, notesBoxX + 8, ny, { size: 7.5 });
        ny -= 10.5;
      }
    }
    page.drawRectangle({ x: totalsBoxX, y: top - totalsH, width: totalsBoxW, height: totalsH, color: softFill, borderColor: line, borderWidth: 0.75 });
    let ty = top - 12;
    for (const [label, value, emphasis] of totalsRows) {
      text(label, totalsBoxX + 8, ty, { size: emphasis ? 8.5 : 7.5, f: emphasis ? bold : font });
      rightText(value, totalsBoxX + totalsBoxW - 8, ty, { size: emphasis ? 8.5 : 7.5, f: emphasis ? bold : font });
      ty -= 11.5;
    }
  }

  // ----- Pie de verificación DIAN, calcado de la factura de referencia
  // (2026-09-03, "debe ser así el diseño... y siempre en la parte inferior
  // de la página"): rótulo de página, regla, teléfono del vendedor a la
  // izquierda y su correo a la derecha, CUFE y URL, y el QR recostado
  // contra el margen derecho ocupando todo el alto del bloque.
  //
  // Va SIEMPRE anclado al pie de la hoja, no a continuación del contenido
  // -- por eso se calcula su alto primero y se posiciona desde `margin`
  // hacia arriba, ignorando dónde terminó el cuerpo. Se repite en todas las
  // páginas.
  //
  // Cuando la factura todavía no pasó por la DIAN, en el lugar del QR queda
  // un recuadro vacío (mismo tamaño y posición, solo el borde) y CUFE/URL
  // quedan con su rótulo pero sin valor: el CUFE es un hash que calculamos
  // nosotros ANTES de enviar, así que existe aunque la DIAN haya rechazado
  // el envío (ver sendInvoiceToDian.ts, se persiste en ambas ramas) --
  // mostrarlo, o peor un QR apuntando al catálogo real de la DIAN, para un
  // documento que la DIAN nunca recibió sería un dato que aparenta ser
  // oficial y verificable sin serlo. El estado se explica arriba del
  // bloque, en texto llano (pedido explícito: "no así con alerta, debe ser
  // más profesional").
  //
  // En una REMISIÓN no hay proceso DIAN en absoluto: no se dibujan ni CUFE,
  // ni URL, ni QR, ni recuadro vacío, ni aviso de estado -- pero el bloque
  // conserva exactamente el mismo alto, para que el documento tenga la misma
  // silueta que una factura y no se note el hueco.
  const qrSize = 66;
  const qrX = pageWidth - margin - qrSize;
  const textRight = qrX - 14;
  const showDianBlock = !input.isRemision;
  const showQr = showDianBlock && isValidated && !!input.qrVerificationUrl;
  const valueX = margin + 34;
  const valueW = textRight - valueX;

  const statusNote = !showDianBlock || isValidated
    ? null
    : input.status === "rejected" || input.status === "error"
      ? `Documento rechazado por la DIAN${input.statusDetail ? `. ${input.statusDetail}` : ""}. No tiene CUFE ni código de verificación asignados.`
      : "Documento pendiente de envío a la DIAN. Todavía no tiene CUFE ni código de verificación asignados.";
  const noteLines = statusNote ? wrapText(statusNote, font, 7, textRight - margin - 60) : [];
  const cufeLines = showDianBlock && isValidated && input.cufe ? wrapText(input.cufe, font, 7, valueW) : [];
  const urlLines = showQr ? wrapText(input.qrVerificationUrl!, font, 7, valueW) : [];

  const headLines = Math.max(1, noteLines.length);
  const footerH = Math.max(
    headLines * 9 + 3 + 12 + 14 + Math.max(1, cufeLines.length) * 9 + Math.max(1, urlLines.length) * 9 + 12,
    qrSize + 22,
  );
  const footerTop = margin + footerH;

  // El QR se genera una sola vez y se reutiliza en cada página.
  const qrImage = showQr
    ? await pdfDoc.embedPng(Uint8Array.from(atob((await QRCode.toDataURL(input.qrVerificationUrl!, { margin: 1, width: 240 })).split(",")[1]), (c) => c.charCodeAt(0)))
    : null;

  function drawFooter(pageNum: number, pageCount: number) {
    // Aviso de estado a la izquierda y rótulo de página a la derecha, ambos
    // arriba de la regla.
    let fy = footerTop;
    rightText(`Pág. ${pageNum} de ${pageCount}`, textRight, fy, { size: 7.5, f: bold });
    for (const l of noteLines) {
      text(l, margin, fy, { size: 7 });
      fy -= 9;
    }
    if (!noteLines.length) fy -= 9;
    fy -= 3;

    page.drawLine({ start: { x: margin, y: fy }, end: { x: textRight, y: fy }, thickness: 0.75, color: line });
    fy -= 12;

    const phoneLine = [input.seller.country, input.seller.contact_phone].filter(Boolean).join(": ");
    if (phoneLine) text(phoneLine, margin, fy, { size: 7.5 });
    if (input.seller.contact_email) rightText(input.seller.contact_email, textRight, fy, { size: 7.5 });
    fy -= 14;

    if (showDianBlock) {
      text("CUFE:", margin, fy, { size: 7, f: bold });
      cufeLines.forEach((l, idx) => text(l, valueX, fy - idx * 9, { size: 7, color: gray }));
      text("URL:", margin, fy - Math.max(1, cufeLines.length) * 9, { size: 7, f: bold });
      urlLines.forEach((l, idx) => text(l, valueX, fy - Math.max(1, cufeLines.length) * 9 - idx * 9, { size: 7, color: gray }));
    }
    fy -= Math.max(1, cufeLines.length) * 9 + Math.max(1, urlLines.length) * 9 + 3;

    text("Programa de facturación propio", margin, fy, { size: 6.5, color: gray });

    // El QR (o su recuadro vacío) arranca en la regla y baja hasta el pie.
    const qrY = footerTop - headLines * 9 - 3 - qrSize;
    if (qrImage) page.drawImage(qrImage, { x: qrX, y: qrY, width: qrSize, height: qrSize });
    else if (showDianBlock) page.drawRectangle({ x: qrX, y: qrY, width: qrSize, height: qrSize, borderColor: line, borderWidth: 0.75 });
  }

  // ----- Reparto en páginas y dibujo -----
  // La tabla puede llegar hasta justo encima del pie; en la ÚLTIMA página
  // tiene que dejar además el hueco de los totales, que van entre la tabla y
  // el pie. Por eso el límite depende de si la fila que se está colocando es
  // la última de la factura.
  const tableBottomNormal = footerTop + 14;
  const tableBottomLast = tableBottomNormal + summaryH + 15;

  // El encabezado de la primera página se dibuja ya mismo, y su `y` de
  // cierre sirve además como tope de la tabla en las páginas siguientes: el
  // contenido del encabezado es idéntico en todas, así que mide igual.
  const otherTableTop = drawHeader();
  const firstTableTop = drawClientBox(otherTableTop);

  const pages: (typeof measured)[] = [];
  let idx = 0;
  do {
    const top = pages.length === 0 ? firstTableTop : otherTableTop;
    const rows: typeof measured = [];
    let cursor = top - 13; // debajo del encabezado de la tabla
    while (idx < measured.length) {
      const isLastRow = idx === measured.length - 1;
      const limit = isLastRow ? tableBottomLast : tableBottomNormal;
      if (cursor - measured[idx].h < limit) break;
      cursor -= measured[idx].h;
      rows.push(measured[idx]);
      idx++;
    }
    // Una fila más alta que una página entera igual tiene que dibujarse en
    // alguna, si no el bucle no avanzaría nunca.
    if (rows.length === 0 && idx < measured.length) {
      rows.push(measured[idx]);
      idx++;
    }
    pages.push(rows);
  } while (idx < measured.length);

  for (let p = 0; p < pages.length; p++) {
    let top = firstTableTop;
    if (p > 0) {
      page = pdfDoc.addPage(PAGE_SIZE);
      top = drawHeader();
    }
    const isLast = p === pages.length - 1;
    const bottom = isLast ? tableBottomLast : tableBottomNormal;
    drawTable(top, bottom, pages[p]);
    if (isLast) drawSummary(bottom - 15);
    drawFooter(p + 1, pages.length);
  }

  return pdfDoc.save();
}
