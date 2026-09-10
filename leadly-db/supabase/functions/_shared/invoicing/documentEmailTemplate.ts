/** Plantilla del correo de entrega de documentos electrónicos al
 * adquiriente (Anexo Técnico numeral 9.3, "Entrega de la factura
 * electrónica"). Aprobada por el usuario el 2026-09-10 sobre una vista
 * previa renderizada.
 *
 * Escrita con tablas y estilos en línea a propósito: los clientes de
 * correo (Outlook sobre todo) ignoran hojas de estilo, flexbox y grid.
 * Nada de imágenes remotas salvo el logo del tenant, que ya vive en un
 * bucket público -- si el cliente bloquea imágenes, el correo se sigue
 * entendiendo entero. */

export type DocumentKind = "invoice" | "credit_note";

export interface DocumentEmailInput {
  kind: DocumentKind;
  /** Nombre comercial del emisor, el que ve el comprador arriba de todo. */
  sellerName: string;
  sellerLegalName: string | null;
  sellerDocument: string | null;
  sellerCity: string | null;
  sellerEmail: string | null;
  sellerLogoUrl: string | null;
  buyerName: string | null;
  /** "FE-12" / "NC-1". */
  documentLabel: string;
  issueDateLabel: string;
  totalLabel: string;
  /** CUFE o CUDE. `null` cuando la DIAN todavía no validó el documento --
   * en ese caso NO se promete validación ninguna (mismo criterio que
   * `isRemision` en el PDF: no aparentar un comprobante que no existe). */
  fiscalCode: string | null;
  verificationUrl: string | null;
  attachments: string[];
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function documentEmailSubject(input: DocumentEmailInput): string {
  const noun = input.kind === "invoice" ? "Factura electrónica" : "Nota crédito";
  return `${noun} ${input.documentLabel} · ${input.sellerName}`;
}

export function buildDocumentEmailHtml(input: DocumentEmailInput): string {
  const heading = input.kind === "invoice" ? "Factura electrónica de venta" : "Nota crédito";
  const greeting = input.buyerName ? `Hola ${esc(input.buyerName)}, ` : "";
  const noun = input.kind === "invoice" ? "tu factura electrónica" : "la nota crédito de tu compra";

  const logoBlock = input.sellerLogoUrl
    ? `<img src="${esc(input.sellerLogoUrl)}" alt="${esc(input.sellerName)}" height="34" style="height:34px;display:block;border:0;"/>`
    : `<span style="font-size:17px;font-weight:800;color:#101a35;letter-spacing:-.2px;">${esc(input.sellerName)}</span>`;

  const validationBlock = input.fiscalCode
    ? `
   <tr><td style="padding:18px 30px 0;">
     <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#eafaf9;border:1px solid #9be1dd;border-radius:10px;">
       <tr><td style="padding:14px 16px;">
         <p style="margin:0 0 6px;font-size:13px;font-weight:700;color:#1e6a66;">&#10003; Documento validado por la DIAN</p>
         <p style="margin:0 0 3px;font-size:11px;color:#256b67;">${input.kind === "invoice" ? "CUFE" : "CUDE"}</p>
         <p style="margin:0;font-size:10px;color:#1e6a66;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.5;">${esc(input.fiscalCode)}</p>
       </td></tr>
     </table>
   </td></tr>`
    : "";

  const verifyBlock = input.verificationUrl
    ? `
   <tr><td align="center" style="padding:20px 30px 4px;">
     <a href="${esc(input.verificationUrl)}" style="display:inline-block;background:#101a35;color:#ffffff;text-decoration:none;font-size:13px;font-weight:700;padding:12px 26px;border-radius:8px;">Verificar en la DIAN</a>
   </td></tr>
   <tr><td align="center" style="padding:8px 30px 24px;">
     <p style="margin:0;font-size:11px;color:#9aa3b2;line-height:1.5;">Puedes consultar este documento en el cat&aacute;logo p&uacute;blico de la DIAN con el ${input.kind === "invoice" ? "CUFE" : "CUDE"} y el NIT del emisor.</p>
   </td></tr>`
    : `<tr><td style="padding:0 30px 20px;"></td></tr>`;

  const attachmentLabels: Record<string, string> = {
    pdf: "representaci&oacute;n gr&aacute;fica",
    xml: "formato electr&oacute;nico de generaci&oacute;n",
  };
  const attachmentRows = input.attachments
    .map((name) => {
      const ext = name.toLowerCase().endsWith(".xml") ? "xml" : "pdf";
      const icon = ext === "xml" ? "&#129534;" : "&#128196;";
      return `<p style="margin:0 0 4px;font-size:12px;color:#374151;">${icon} ${esc(name)} &nbsp;<span style="color:#9aa3b2;">${attachmentLabels[ext]}</span></p>`;
    })
    .join("\n         ");

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/></head>
<body style="margin:0;padding:0;background:#f4f6f8;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f6f8;padding:28px 12px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
 <tr><td align="center">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e7ef;">

   <tr><td style="padding:26px 30px 20px;border-bottom:3px solid #101a35;">
     <table width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
       <td>${logoBlock}</td>
       <td align="right" style="font-size:11px;color:#6b7280;line-height:1.5;">
         ${input.sellerDocument ? `NIT ${esc(input.sellerDocument)}<br/>` : ""}${input.sellerCity ? esc(input.sellerCity) : ""}
       </td>
     </tr></table>
   </td></tr>

   <tr><td style="padding:26px 30px 6px;">
     <p style="margin:0 0 4px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6b7280;font-weight:700;">${heading}</p>
     <p style="margin:0 0 14px;font-size:26px;font-weight:800;color:#101a35;letter-spacing:-.5px;">${esc(input.documentLabel)}</p>
     <p style="margin:0 0 18px;font-size:14px;color:#374151;line-height:1.6;">
       ${greeting}adjuntamos ${noun}.${input.attachments.length > 1 ? " Encontrar&aacute;s la representaci&oacute;n gr&aacute;fica en PDF y el archivo XML firmado." : ""}
     </p>
   </td></tr>

   <tr><td style="padding:0 30px;">
     <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f9fc;border:1px solid #e2e7ef;border-radius:10px;">
       <tr>
         <td style="padding:14px 16px;font-size:12px;color:#6b7280;">Fecha de emisi&oacute;n</td>
         <td align="right" style="padding:14px 16px;font-size:13px;color:#101a35;font-weight:600;">${esc(input.issueDateLabel)}</td>
       </tr>
       <tr>
         <td style="padding:0 16px 14px;font-size:12px;color:#6b7280;">Total</td>
         <td align="right" style="padding:0 16px 14px;font-size:18px;color:#101a35;font-weight:800;">${esc(input.totalLabel)}</td>
       </tr>
     </table>
   </td></tr>
${validationBlock}
${verifyBlock}

   <tr><td style="padding:0 30px 26px;">
     <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-top:1px solid #eef1f6;">
       <tr><td style="padding-top:14px;">
         <p style="margin:0 0 8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#9aa3b2;font-weight:700;">Adjuntos</p>
         ${attachmentRows}
       </td></tr>
     </table>
   </td></tr>

   <tr><td style="padding:18px 30px;background:#fafbfd;border-top:1px solid #eef1f6;">
     <p style="margin:0 0 3px;font-size:11px;color:#6b7280;line-height:1.6;">
       ${esc(input.sellerLegalName ?? input.sellerName)}${input.sellerDocument ? ` &middot; NIT ${esc(input.sellerDocument)}` : ""}
     </p>
     ${input.sellerEmail ? `<p style="margin:0 0 10px;font-size:11px;color:#6b7280;line-height:1.6;">${esc(input.sellerEmail)}</p>` : ""}
     <p style="margin:0;font-size:10px;color:#aeb6c4;line-height:1.6;">
       Este es un mensaje autom&aacute;tico de entrega de documentos electr&oacute;nicos. No respondas a este correo.
     </p>
   </td></tr>

  </table>
 </td></tr>
</table>
</body></html>`;
}
