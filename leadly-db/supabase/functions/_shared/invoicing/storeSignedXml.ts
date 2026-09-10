/** Conservación del XML firmado que se transmite a la DIAN.
 *
 * Hueco real hasta 2026-09-10: `sales_invoices.xml_storage_path` existía
 * desde que se creó la tabla y hasta figuraba en los tipos del frontend,
 * pero NINGÚN código lo escribía -- el XML se construía, se firmaba, se
 * mandaba y se descartaba. Es el documento electrónico de generación: el
 * que el facturador debe conservar y el que el Anexo Técnico (numeral 9.3)
 * admite entregarle al adquiriente.
 *
 * Se guarda ANTES de transmitir, no después de que la DIAN acepte, por
 * tres razones: (1) si el envío revienta a mitad de camino quedan los bytes
 * exactos que se iban a transmitir, que es justo lo que hace falta para
 * diagnosticar; (2) cada intento es una fila propia (`attempt_number`), así
 * que nunca se pisa el XML de un intento anterior; (3) no puede fallar
 * "después de que ya existe la factura", que sería el peor momento.
 *
 * NUNCA lanza. Un fallo de Storage no puede impedir emitir una factura: la
 * existencia legal del documento la establece la aceptación de la DIAN, no
 * nuestro bucket. Si falla, `xml_storage_path` queda en null -- un hueco
 * visible y consultable, no un silencio. */

/** Guarda `xml` en el bucket privado `sales-documents` y deja la ruta en la
 * fila. Devuelve la ruta, o null si no se pudo guardar. */
// deno-lint-ignore no-explicit-any
export async function storeSignedXml(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  params: {
    tenantId: string;
    /** "sales_invoices" | "sales_credit_notes" */
    table: "sales_invoices" | "sales_credit_notes";
    rowId: string;
    /** Nombre legible del archivo, sin extensión (ej. "FE12", "NC1"). */
    documentName: string;
    xml: string;
  },
): Promise<string | null> {
  const folder = params.table === "sales_invoices" ? "invoices" : "credit-notes";
  // El primer segmento DEBE ser el tenant_id -- la policy de lectura del
  // bucket aísla por carpeta (storage.foldername(name))[1].
  const path = `${params.tenantId}/${folder}/${params.rowId}/${params.documentName}.xml`;
  try {
    const { error: uploadError } = await adminClient.storage
      .from("sales-documents")
      .upload(path, new Blob([xmlWithBom(params.xml)], { type: "application/xml" }), {
        contentType: "application/xml",
        upsert: true,
      });
    if (uploadError) throw uploadError;
    const { error: updateError } = await adminClient
      .from(params.table)
      .update({ xml_storage_path: path })
      .eq("id", params.rowId);
    if (updateError) throw updateError;
    return path;
  } catch (err) {
    console.error(`[storeSignedXml] no se pudo conservar el XML de ${params.table}/${params.rowId}:`, err);
    return null;
  }
}

/** Descarga un XML ya conservado. Devuelve null si no existe o falla --
 * el caller decide si eso es un problema (para el correo, significa
 * mandar solo el PDF en vez de no mandar nada). */
export async function fetchStoredXml(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  path: string | null,
): Promise<string | null> {
  if (!path) return null;
  try {
    const { data, error } = await adminClient.storage.from("sales-documents").download(path);
    if (error || !data) return null;
    return await data.text();
  } catch (err) {
    console.error(`[fetchStoredXml] no se pudo leer ${path}:`, err);
    return null;
  }
}

/** La DIAN transmite el XML sin BOM (así se firma y así se zipea, ver
 * zip.ts) -- se conserva exactamente igual, sin agregar nada, para que el
 * archivo guardado sea byte a byte el que se transmitió. Esta función
 * existe solo para dejar explícito que NO se toca el contenido. */
function xmlWithBom(xml: string): string {
  return xml;
}
