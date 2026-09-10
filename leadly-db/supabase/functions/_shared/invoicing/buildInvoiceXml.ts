/** Construcción del XML UBL 2.1 de la Factura Electrónica de Venta --
 * Fase 2. Estructura basada en:
 * 1. El texto del Anexo Técnico v1.9 (Resolución 000165 de 2023) para los
 *    VALORES de cada código (CustomizationID, tipos de documento, tipos de
 *    impuesto).
 * 2. El XML de ejemplo oficial `Generica.xml` del kit de herramientas de la
 *    DIAN (mismo namespace/orden de elementos) para la ESTRUCTURA -- ver
 *    _shared/invoicing/dian-reference/ejemplos-xml/Generica.xml.
 *
 * ⚠️ Diferencia encontrada entre ambas fuentes: Generica.xml usa
 * CustomizationID="05", pero el texto vigente del Anexo (catálogo
 * TipoOperacionF-2.1.gc) dice que "10" es "Estándar" -- se sigue el texto
 * vigente (10), no el ejemplo, porque el ejemplo es un archivo de
 * demostración que puede no estar actualizado a la última versión del
 * catálogo.
 *
 * Deliberadamente NO incluye (quedan para cuando haya un caso real que lo
 * necesite, no se inventan ahora): AllowanceCharge, PrepaidPayment,
 * BillingReference, Delivery/DeliveryTerms, multi-moneda.
 *
 * Este archivo construye el XML SIN FIRMAR, pero ya deja un
 * `<ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension>` VACÍO como
 * segundo elemento de `ext:UBLExtensions` (mismo lugar exacto donde
 * Generica.xml pone su `ds:Signature` real) -- es a propósito: la firma
 * envolvente (enveloped-signature) calcula su hash sobre el documento tal
 * cual va a quedar al final, así que el hueco donde va la firma tiene que
 * existir ANTES de firmar, no agregarse después por fuera. Ver
 * signInvoiceXml.ts, que llena ese hueco.
 *
 * ⚠️ RONDA DE CORRECCIÓN 2026-09-09, contra el primer rechazo real de la
 * DIAN (27 reglas distintas, ver conversación) -- se descargó el PDF
 * oficial completo del Anexo Técnico v1.9 (753 páginas) y se releyó cada
 * regla citada por el rechazo (tabla de reglas FAJ/FAK/FAN/FAS/FAU,
 * páginas 389-438) para corregir contra el texto exacto, no adivinar de
 * nuevo. Cambios reales, no cosméticos:
 * 1. BUG DE FONDO: `cac:InvoiceLine/cbc:LineExtensionAmount` (y por lo
 *    tanto `LegalMonetaryTotal/LineExtensionAmount`+`TaxExclusiveAmount`)
 *    se estaban llenando con el subtotal de línea TAL CUAL viene de
 *    `sales_invoice_items.subtotal` -- que en este sistema es el monto
 *    CON impuesto incluido (ver CLAUDE.md: "el precio ya incluye el
 *    impuesto, se extrae, no se suma"). Pero UBL/DIAN exige que
 *    LineExtensionAmount sea el valor SIN impuesto (confirmado
 *    carácter por carácter contra Generica.xml: en su línea 1,
 *    LineExtensionAmount=12600.06 es EXACTAMENTE igual a
 *    TaxSubtotal/TaxableAmount=12600.06 de esa misma línea) -- de ahí
 *    la regla FAU04 ("Base Imponible es distinto a la suma de las bases
 *    imponibles de las líneas") y probablemente también corrompía el CUFE
 *    (`valFac` ya se documentaba como "LineExtensionAmount / suma de
 *    taxable_base", pero se le pasaba el total CON impuesto). Ahora cada
 *    línea usa su `taxableAmount` (ya extraído) para LineExtensionAmount Y
 *    para Price/PriceAmount (dividido por cantidad) -- el monto CON
 *    impuesto solo aparece al final, en TaxInclusiveAmount/PayableAmount.
 * 2. `money()` truncaba (Math.trunc) en vez de redondear -- la DIAN compara
 *    con `round()` (confirmado en el texto exacto de FAU04/FAU02/FAS02),
 *    truncar podía desviar la cabecera de la suma de líneas en un
 *    centavo. Se cambió a Math.round (el truncamiento sigue siendo
 *    correcto y sin tocar en cufe.ts -- esa sí es la fórmula literal del
 *    CUFE, un cálculo distinto).
 * 3. `cbc:ProfileID` -- exigido como el literal exacto
 *    "DIAN 2.1: Factura Electrónica de Venta" (regla FAD03), no solo
 *    "DIAN 2.1". Mismo criterio ya usado en buildCreditNoteXml.ts, que
 *    tenía el suyo bien desde el principio.
 * 4. `cbc:AdditionalAccountID` (tipo de organización, reglas FAJ02a/b y
 *    FAK02) faltaba por completo -- va como hijo directo de
 *    AccountingSupplierParty/AccountingCustomerParty, ANTES de cac:Party
 *    (confirmado contra Generica.xml). Valor "1" = persona jurídica, "2" =
 *    persona natural (confirmado contra dos fuentes independientes -- ver
 *    conversación -- Generica.xml usa "1" para dos entidades claramente
 *    jurídicas).
 * 5. `cbc:TaxLevelCode` (responsabilidad fiscal, reglas FAJ26/FAK26)
 *    faltaba -- el catálogo vigente desde agosto 2020 (verificado, NO es
 *    el "O-99" que usaba Generica.xml de 2019, que ya no es válido) es
 *    O-13/O-15/O-23/O-47/R-99-PN. Sin un catálogo propio de
 *    responsabilidades por tenant/cliente, se usa la única señal real que
 *    ya se recolecta (`is_self_withholding_agent`/`applies_withholding`)
 *    para O-15 (Autorretenedor), y R-99-PN (No responsable) como default
 *    seguro en cualquier otro caso -- nunca se inventa O-13/O-23/O-47 sin
 *    dato real detrás.
 * 6. `cac:PartyLegalEntity/cac:CorporateRegistrationScheme` (reglas
 *    FAB10a/FAJ50, "el prefijo debe corresponder al código de la sucursal
 *    de este punto de facturación") faltaba en el emisor -- se agrega con
 *    `cbc:ID` = el prefijo de la resolución vigente.
 * 7. `cac:PaymentMeans` (reglas FAN01/FAN02/FAN03) faltaba por completo --
 *    se agrega con `cbc:ID` "1" (contado) o "2" (crédito, si algún pago
 *    real de la orden fue a crédito) y `cbc:PaymentMeansCode` derivado del
 *    método de pago real más reciente (efectivo→10, transferencia/
 *    wompi→42, tarjeta→48, resto→1 "instrumento no definido").
 * 8. `cbc:ID`/`cbc:CountrySubentityCode` (código DANE de municipio/
 *    departamento, reglas FAJ09/FAJ12/FAJ29/FAJ32, rechazo real para el
 *    emisor) -- nuevo `tenant_dian_profile.city_code`/`state_code`
 *    (campo manual, sin catálogo DIVIPOLA embebido -- ver la migración
 *    20260909230000). Mismo campo para la dirección del comprador
 *    (`contact_addresses.city_code`/`state_code`), opcional -- mientras
 *    un cliente no lo tenga cargado, esos dos elementos simplemente no se
 *    emiten para él (gap conocido, no silencioso: puede seguir generando
 *    el rechazo puntual FAK29/FAK32 hasta que se cargue el dato).
 * Pendiente explícito, fuera de esta ronda: ZE02 ("Valida firma del
 * documento") -- ver el ajuste hecho en signInvoiceXml.ts (transforms),
 * hipótesis razonable pero sin confirmar todavía contra un envío real.
 *
 * ⚠️ SEGUNDA RONDA 2026-09-09/10, contra un rechazo real posterior (FAU04,
 * FAK09/29/32/61, FAS01a/b, FAZ09, entre otras -- ver la conversación):
 * 9. FAU04 ("Base Imponible distinto a la suma de las bases imponibles de
 *    las líneas"): el bug no era el valor en sí (ya se corregía en la
 *    ronda anterior) sino EL ORDEN del redondeo -- se sumaban los montos
 *    de línea SIN redondear y recién se redondeaba el total una sola vez,
 *    mientras que cada línea en el XML ya sale redondeada a 2 decimales
 *    por separado. Sumar N líneas redondeadas puede diferir en un centavo
 *    de redondear la suma exacta (ej. tres líneas de 12600.005 cada una
 *    redondean a 12600.01 = 37800.03, pero round(37800.015) puede dar
 *    37800.02) -- la DIAN compara contra la suma de los valores YA
 *    IMPRESOS en el XML, no contra el cálculo exacto interno. Ahora cada
 *    línea se redondea PRIMERO (taxable, impuesto) y el header/los
 *    TaxTotal se arman sumando esos valores ya redondeados, nunca al revés.
 * 10. FAS01a/FAS01b ("TaxTotal de cabecera no coincide / impuesto informado
 *    en cabecera sin ninguna línea que lo tenga"): el código anterior
 *    emitía SIEMPRE los tres `cac:TaxTotal` (IVA/INC/ICA), incluso con
 *    monto 0 para el impuesto que ninguna línea usaba -- eso es
 *    exactamente lo que rechaza la regla ("debe existir un TaxTotal por
 *    cada tipo de impuesto que se informa a nivel de línea", léase
 *    también al revés: no debe existir uno para el que NO se informa en
 *    ninguna línea). Ahora solo se emite un TaxTotal por código realmente
 *    presente en al menos una línea, y si ese código aparece con más de
 *    una tarifa (ej. IVA 19% y 5% en la misma factura), se agrupan en
 *    varios `cac:TaxSubtotal` DENTRO del mismo TaxTotal (texto exacto de
 *    FAS01a), no en TaxTotal separados.
 * 11. FAK61 ("AdditionalAccountID=2 sin el grupo PartyIdentification"):
 *    faltaba por completo `cac:PartyIdentification` en el comprador --
 *    obligatorio cuando es persona natural (AdditionalAccountID="2",
 *    FAK61/62/63). Se agrega con el mismo documento/tipo ya usado en
 *    PartyTaxScheme/CompanyID. Solo aplica al comprador (el vendedor de
 *    esta plataforma siempre es persona jurídica).
 * 12. FAZ09 (notificación, "debe existir el grupo de identificación
 *    estándar del bien"): el elemento que de verdad pide esa regla
 *    (`cac:StandardItemIdentification`) exige un código de un estándar
 *    EXTERNO acreditado (GTIN/UNSPSC/EAN, catálogo 13.3.5 con
 *    schemeAgencyID/schemeID reales) que esta plataforma no tiene --
 *    inventar un scheme ahí sería peor (dispara FAZ10/FAZ11, sí de
 *    rechazo). En vez de eso se llena `cac:SellersItemIdentification`
 *    (FAZ06/07, un grupo aparte para el código PROPIO del vendedor, sin
 *    exigir ningún estándar externo) con el SKU real del producto cuando
 *    existe -- deja la notificación de FAZ09 sin resolver a propósito
 *    (dato que genuinamente no existe) pero aporta lo que sí es cierto.
 * Sigue pendiente, no accionable desde código: FAJ43b (el nombre/razón
 * social configurado debe coincidir carácter a carácter con el RUT de la
 * DIAN para ese NIT -- es una validación contra un registro externo, no
 * un bug de este archivo) y ZE02 (firma, ver arriba).
 *
 * ⚠️ TERCERA RONDA 2026-09-10, probando contra un pedido real del POS sin
 * ninguna dirección guardada (venta de mostrador a un cliente identificado
 * por cédula, sin domicilio cargado -- caso real y frecuente, no un dato
 * faltante por error): `addressLine`/`city`/`stateProvince` pasan a ser
 * NULLABLE en vez de recibir el placeholder de texto "N/A" que usaba el
 * código anterior. Mandar "N/A" como si fuera el nombre real de una
 * ciudad/dirección es justo lo que dispara los rechazos de código
 * inválido (FAK09/FAK29/FAK32 del lado del comprador) -- el grupo de
 * dirección (`cac:PhysicalLocation`, `cac:PartyTaxScheme/RegistrationAddress`)
 * es EXPLÍCITAMENTE opcional en el Anexo ("grupo opcional, si se informa
 * el grupo aplican las reglas del grupo", FAK07/FAK27) y su ausencia total
 * es apenas una NOTIFICACIÓN (FAK08/FAK28), mucho más segura que rellenar
 * con un valor inventado que sí puede rechazar la factura entera. Ahora,
 * si no hay dirección real, el grupo completo se omite -- no se inventa
 * nada. Si hay dirección pero sin código DANE, se manda igual (sin
 * `cbc:ID`/`CountrySubentityCode`) y queda como esa misma notificación
 * blanda, en vez de bloquear el envío por completo (decisión explícita:
 * una venta real no debería quedar sin poder facturarse solo porque le
 * falta el código DIVIPOLA de una dirección que si existe).
 *
 * ⚠️ CUARTA RONDA 2026-09-10, primer rechazo real de PRODUCCIÓN (contra
 * SendBillSync, ver sendInvoiceToDian.ts -- distinto ambiente, reglas
 * nuevas que habilitación nunca disparó):
 * 13. BUG DE FONDO (FAD06+FAD07): `cbc:UUID` (el CUFE) llevaba
 *    `schemeID="2"` HARDCODEADO sin importar el ambiente -- correcto por
 *    accidente en habilitación (`input.environment` también es 2 ahí) pero
 *    roto en producción, donde `input.environment` es 1. Confirmado
 *    carácter a carácter contra el Anexo Técnico v1.9 (tabla de reglas,
 *    entradas FAD06/FAD07): `@schemeID` de `cbc:UUID` es el "testigo de que
 *    el valor registrado... es lo que desea realizar el HFE: en igualdad
 *    confirma el ambiente y en desigualdad rechaza el procesamiento" -- la
 *    DIAN recalcula el CUFE usando el ambiente que ese atributo declara, así
 *    que un `schemeID` que no coincide con el ambiente real vuelve inválido
 *    el CUFE entero (FAD06) además de fallar por sí solo (FAD07). Ahora
 *    `schemeID="${input.environment}"`, igual que `cbc:ProfileExecutionID`
 *    (que sí ya usaba el valor real) -- mismo criterio que ya tenía bien
 *    buildCreditNoteXml.ts desde el principio.
 * 14. FAJ71 (rechazo, no notificación -- confirmado contra la tabla de
 *    reglas: "R", no "N"): falta el grupo `cac:Contact` del EMISOR
 *    (`/Invoice/cac:AccountingSupplierParty/cac:Party/cac:Contact/
 *    cbc:ElectronicMail`) -- opcional en el esquema (`0..1`), pero real: es
 *    el correo de recepción de documentos electrónicos que el tenant debe
 *    tener registrado en su cuenta de facturación electrónica de la DIAN.
 *    Se agrega con el correo de contacto real del tenant
 *    (`tenants.contact_email`, ya cargado y obligatorio en Configuración,
 *    nunca un valor inventado) -- pero si la DIAN tiene registrado un correo
 *    DISTINTO para ese NIT, el rechazo persiste hasta que el tenant lo
 *    actualice en el portal de la DIAN (o hasta que coincida con
 *    `contact_email`); esa parte no es accionable desde este código, es un
 *    dato de la cuenta DIAN del tenant, no del XML. */

import { computeCufe, computeSoftwareSecurityCode } from "./cufe.ts";
import { computeNitCheckDigit } from "./nit.ts";

/** Códigos DIAN (tax_types.code) -> nombre exacto que exige el XML en
 * cac:TaxScheme/cbc:Name (ver Generica.xml: <cbc:Name>IVA</cbc:Name> etc). */
const TAX_SCHEME_NAME: Record<string, string> = { "01": "IVA", "03": "ICA", "04": "INC" };

/** document_types.code -> schemeName que exige TipoIdFiscal-2.1.gc
 * (idéntico código, no hace falta traducir -- ambos catálogos usan los
 * mismos valores 11/12/13/21/22/31/41/42/50/91). */

export interface InvoiceXmlParty {
  legalName: string;
  documentTypeCode: string; // document_types.code (ej. "31" = NIT)
  documentNumber: string; // sin puntos ni guiones, sin DV
  /** `null` cuando genuinamente no hay dirección cargada (ej. venta de
   * mostrador a un cliente sin domicilio guardado) -- el grupo de
   * dirección se omite entero en ese caso, nunca se manda un placeholder
   * de texto (ver el comentario de cabecera, ronda 2026-09-10). */
  addressLine: string | null;
  city: string | null;
  stateProvince: string | null;
  countryCode: string; // ISO alpha-2, ej. "CO"
  /** Código DANE de municipio/departamento (DIVIPOLA) -- reglas
   * FAJ09/FAJ12/FAJ29/FAJ32 (emisor, rechazo real) y FAK09/FAK29/FAK32
   * (receptor). Opcional a propósito: sin este dato cargado (ver
   * tenant_dian_profile.city_code/contact_addresses.city_code), esos
   * elementos simplemente no se emiten -- nunca se inventa un código. */
  cityCode?: string | null;
  stateCode?: string | null;
  /** "1" persona jurídica, "2" persona natural (cbc:AdditionalAccountID,
   * reglas FAJ02a/b, FAK02) -- confirmado contra dos fuentes independientes
   * que "1" = jurídica (Generica.xml usa "1" para dos entidades claramente
   * jurídicas). Si no se pasa, se infiere de documentTypeCode ("31" NIT ->
   * jurídica, cualquier otro -> natural) como mejor esfuerzo. */
  organizationType?: "1" | "2";
  /** Responsabilidad fiscal (cbc:TaxLevelCode, reglas FAJ26/FAK26) -- catálogo
   * vigente desde agosto 2020: O-13/O-15/O-23/O-47/R-99-PN (el "O-99" que
   * usaba la versión vieja de este archivo ya no es válido). Sin un
   * catálogo propio de responsabilidades, default "R-99-PN" (No
   * responsable) si no se especifica -- nunca se inventa O-13/O-23/O-47
   * sin dato real. */
  taxLevelCode?: string;
  /** cac:Contact/cbc:ElectronicMail (regla FAJ71, rechazo) -- correo de
   * recepción de documentos electrónicos del EMISOR ante la DIAN. Solo
   * aplica al vendedor (ver el comentario de cabecera, ronda 2026-09-10);
   * se omite el grupo entero si no hay un correo real cargado, nunca se
   * inventa uno. */
  electronicMail?: string | null;
}

export interface InvoiceXmlLineTax {
  code: string; // "01" | "04" | "03"
  rate: number;
  taxableAmount: number;
  taxAmount: number;
}

export interface InvoiceXmlLine {
  id: number;
  description: string;
  quantity: number;
  unitPrice: number; // sin impuesto (BaseQuantity=1 implícito)
  lineExtensionAmount: number; // subtotal de la línea sin impuesto
  tax: InvoiceXmlLineTax | null;
  /** cac:Item/cac:StandardItemIdentification, regla FAZ09 (notificación) --
   * opcional, se omite si el producto no tiene SKU cargado. */
  sku?: string | null;
}

export interface InvoiceXmlWithholding {
  code: "05" | "06" | "07";
  rate: number;
  base: number;
  amount: number;
}

export interface BuildInvoiceXmlInput {
  invoiceId: string; // prefijo + consecutivo, ej. "SETP990000001"
  issueDate: string; // YYYY-MM-DD
  issueTime: string; // HH:MM:SS-05:00
  currency: string; // ej. "COP"
  environment: 1 | 2; // 1 producción, 2 habilitación
  seller: InvoiceXmlParty;
  buyer: InvoiceXmlParty;
  lines: InvoiceXmlLine[];
  withholdings: InvoiceXmlWithholding[];
  resolution: {
    number: string;
    prefix: string;
    rangeFrom: string;
    rangeTo: string;
    validFrom: string; // YYYY-MM-DD
    validUntil: string; // YYYY-MM-DD
  };
  softwareId: string;
  softwarePin: string;
  technicalKey: string;
  authorizationProviderNit: string; // NIT de la DIAN como proveedor de autorización, fijo: "800197268"
  /** cac:PaymentMeans (reglas FAN01/FAN02/FAN03, faltaba por completo) --
   * meansId "1" contado / "2" crédito (cbc:PaymentMeans/cbc:ID, confirmado
   * contra el Anexo Técnico y Generica.xml), meansCode el medio de pago
   * real (cbc:PaymentMeansCode, catálogo UNCL4461 que usa la DIAN: "10"
   * efectivo, "42" transferencia, "48" tarjeta, "1" instrumento no
   * definido -- fallback seguro para crédito/saldo a favor, que no son un
   * "medio" físico de pago real). */
  payment: {
    meansId: "1" | "2";
    meansCode: string;
  };
}

function esc(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Redondea a 2 decimales -- la DIAN compara con round() (confirmado en el
 * texto exacto de las reglas FAU02/FAU04/FAS02: "round(X) es distinto de
 * round(Y)"), truncar podía desalinear la cabecera de la suma de líneas por
 * un centavo. Distinto, a propósito, del truncamiento de cufe.ts -- esa es
 * la fórmula LITERAL del CUFE, un cálculo separado que si exige truncar. */
function money(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return rounded.toFixed(2);
}

function partyBlock(
  tag: "cac:AccountingSupplierParty" | "cac:AccountingCustomerParty",
  party: InvoiceXmlParty,
  dv?: number,
  /** Prefijo de facturación del punto de venta -- reglas FAB10a/FAJ50,
   * "el prefijo debe corresponder al código de la sucursal de este punto
   * de facturación". Solo aplica al emisor (Xpath confirmado:
   * …//AccountingSupplierParty/.../PartyLegalEntity/CorporateRegistrationScheme),
   * por eso es un parámetro aparte y no un campo de InvoiceXmlParty (que
   * comparten emisor y receptor). */
  branchPrefix?: string,
): string {
  const companyIdAttrs = `schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)"${
    dv !== undefined ? ` schemeID="${dv}"` : ""
  } schemeName="${esc(party.documentTypeCode)}"`;
  const organizationType = party.organizationType ?? (party.documentTypeCode === "31" ? "1" : "2");
  const taxLevelCode = party.taxLevelCode ?? "R-99-PN";
  const cityCodeXml = party.cityCode ? `\n               <cbc:ID>${esc(party.cityCode)}</cbc:ID>` : "";
  const stateCodeXml = party.stateCode ? `\n               <cbc:CountrySubentityCode>${esc(party.stateCode)}</cbc:CountrySubentityCode>` : "";
  // Grupos de dirección (FAK07/FAK27, "opcional, si se informa el grupo
  // aplican las reglas del grupo") -- se omiten ENTEROS si no hay una
  // dirección real, en vez de rellenar con "N/A" (ver el comentario de
  // cabecera, ronda 2026-09-10). Ambos grupos comparten la misma fuente de
  // datos en este archivo, así que una sola condición alcanza para los dos.
  const hasAddress = Boolean(party.addressLine);
  const physicalLocationXml = !hasAddress
    ? ""
    : `
         <cac:PhysicalLocation>
            <cac:Address>${cityCodeXml}
               <cbc:CityName>${esc(party.city ?? "")}</cbc:CityName>
               <cbc:CountrySubentity>${esc(party.stateProvince ?? "")}</cbc:CountrySubentity>${stateCodeXml}
               <cac:AddressLine>
                  <cbc:Line>${esc(party.addressLine ?? "")}</cbc:Line>
               </cac:AddressLine>
               <cac:Country>
                  <cbc:IdentificationCode>${esc(party.countryCode)}</cbc:IdentificationCode>
                  <cbc:Name languageID="es">Colombia</cbc:Name>
               </cac:Country>
            </cac:Address>
         </cac:PhysicalLocation>`;
  const registrationAddressXml = !hasAddress
    ? ""
    : `
            <cac:RegistrationAddress>${cityCodeXml}
               <cbc:CityName>${esc(party.city ?? "")}</cbc:CityName>
               <cbc:CountrySubentity>${esc(party.stateProvince ?? "")}</cbc:CountrySubentity>${stateCodeXml}
               <cac:AddressLine>
                  <cbc:Line>${esc(party.addressLine ?? "")}</cbc:Line>
               </cac:AddressLine>
               <cac:Country>
                  <cbc:IdentificationCode>${esc(party.countryCode)}</cbc:IdentificationCode>
                  <cbc:Name languageID="es">Colombia</cbc:Name>
               </cac:Country>
            </cac:RegistrationAddress>`;
  const corporateRegistrationSchemeXml = branchPrefix
    ? `
            <cac:CorporateRegistrationScheme>
               <cbc:ID>${esc(branchPrefix)}</cbc:ID>
            </cac:CorporateRegistrationScheme>`
    : "";
  // cac:PartyIdentification (reglas FAK61/FAK62/FAK63) -- obligatorio SOLO
  // en el comprador (AccountingCustomerParty) cuando es persona natural
  // (AdditionalAccountID="2"); el vendedor de esta plataforma siempre es
  // persona jurídica, así que nunca aplica del lado del emisor.
  const partyIdentificationXml =
    tag === "cac:AccountingCustomerParty" && organizationType === "2"
      ? `
         <cac:PartyIdentification>
            <cbc:ID ${companyIdAttrs}>${esc(party.documentNumber)}</cbc:ID>
         </cac:PartyIdentification>`
      : "";
  // cac:Contact/cbc:ElectronicMail (regla FAJ71) -- solo el emisor
  // (AccountingSupplierParty), ver el comentario de cabecera. Se omite el
  // grupo entero sin un correo real cargado. Va DESPUÉS de PartyLegalEntity
  // -- orden exacto del esquema UBL 2.1 PartyType (PartyIdentification*,
  // PartyName*, PostalAddress?, PhysicalLocation?, PartyTaxScheme*,
  // PartyLegalEntity*, Contact?, Person*...), no junto a PartyName.
  const contactXml =
    tag === "cac:AccountingSupplierParty" && party.electronicMail
      ? `
         <cac:Contact>
            <cbc:ElectronicMail>${esc(party.electronicMail)}</cbc:ElectronicMail>
         </cac:Contact>`
      : "";
  return `
   <${tag}>
      <cbc:AdditionalAccountID>${organizationType}</cbc:AdditionalAccountID>
      <cac:Party>${partyIdentificationXml}
         <cac:PartyName>
            <cbc:Name>${esc(party.legalName)}</cbc:Name>
         </cac:PartyName>${physicalLocationXml}
         <cac:PartyTaxScheme>
            <cbc:RegistrationName>${esc(party.legalName)}</cbc:RegistrationName>
            <cbc:CompanyID ${companyIdAttrs}>${esc(party.documentNumber)}</cbc:CompanyID>
            <cbc:TaxLevelCode>${esc(taxLevelCode)}</cbc:TaxLevelCode>${registrationAddressXml}
            <cac:TaxScheme>
               <cbc:ID>01</cbc:ID>
               <cbc:Name>IVA</cbc:Name>
            </cac:TaxScheme>
         </cac:PartyTaxScheme>
         <cac:PartyLegalEntity>
            <cbc:RegistrationName>${esc(party.legalName)}</cbc:RegistrationName>
            <cbc:CompanyID ${companyIdAttrs}>${esc(party.documentNumber)}</cbc:CompanyID>${corporateRegistrationSchemeXml}
         </cac:PartyLegalEntity>${contactXml}
      </cac:Party>
   </${tag}>`;
}

export async function buildInvoiceXml(input: BuildInvoiceXmlInput): Promise<{ xml: string; cufe: string }> {
  // Monto SIN impuesto de cada línea -- ver el bug de fondo documentado en
  // el comentario de cabecera del archivo: line.lineExtensionAmount viene
  // CON impuesto incluido (mismo criterio que sales_invoice_items.subtotal
  // en toda la plataforma), pero cac:InvoiceLine/cbc:LineExtensionAmount
  // (y por lo tanto LegalMonetaryTotal/LineExtensionAmount+TaxExclusiveAmount)
  // tienen que ser el valor SIN impuesto -- para una línea con impuesto,
  // ese valor YA está calculado en line.tax.taxableAmount.
  const netLineAmount = (line: InvoiceXmlLine) => (line.tax ? line.tax.taxableAmount : line.lineExtensionAmount);
  const round2 = (value: number) => Math.round(value * 100) / 100;
  // FAU04 (ronda 2026-09-10): sumar los valores YA REDONDEADOS de cada
  // línea -- exactamente los que van impresos en cac:InvoiceLine -- en vez
  // de sumar los montos crudos y redondear una sola vez al final (ver el
  // comentario de cabecera del archivo para el porqué exacto).
  const subtotal = input.lines.reduce((sum, l) => sum + round2(netLineAmount(l)), 0);

  // Agrupado por código DE IMPUESTO + TARIFA (no solo código) -- una
  // factura con dos tarifas del mismo impuesto (ej. IVA 19% y 5%) necesita
  // un cac:TaxSubtotal por tarifa DENTRO de un único cac:TaxTotal por
  // código (regla FAS01a), nunca promediarlas en una ni separarlas en
  // TaxTotal distintos. Y solo se agrupan los códigos que de verdad
  // aparecen en alguna línea (FAS01b) -- emitir un TaxTotal en 0 para un
  // impuesto que ninguna línea usa es justo lo que rechazaba esa regla.
  const taxByCodeAndRate = new Map<string, { code: string; rate: number; taxable: number; amount: number }>();
  for (const line of input.lines) {
    if (!line.tax || line.tax.taxAmount === 0) continue;
    const key = `${line.tax.code}|${line.tax.rate}`;
    const entry = taxByCodeAndRate.get(key) ?? { code: line.tax.code, rate: line.tax.rate, taxable: 0, amount: 0 };
    entry.taxable += round2(line.tax.taxableAmount);
    entry.amount += round2(line.tax.taxAmount);
    taxByCodeAndRate.set(key, entry);
  }
  const TAX_CODE_ORDER = ["01", "04", "03"];
  const taxGroupsByCode = new Map<string, { code: string; rate: number; taxable: number; amount: number }[]>();
  for (const entry of taxByCodeAndRate.values()) {
    const list = taxGroupsByCode.get(entry.code) ?? [];
    list.push(entry);
    taxGroupsByCode.set(entry.code, list);
  }
  const totalForCode = (code: string) => (taxGroupsByCode.get(code) ?? []).reduce((sum, g) => sum + g.amount, 0);
  const ivaTotal = totalForCode("01");
  const incTotal = totalForCode("04");
  const icaTotal = totalForCode("03");
  const taxTotal = ivaTotal + incTotal + icaTotal;
  const taxInclusiveAmount = subtotal + taxTotal;
  const withholdingTotal = input.withholdings.reduce((sum, w) => sum + w.amount, 0);
  // Nota DIAN (Anexo 11.9.1, observación 21/06/2019): la validación previa
  // NO resta las retenciones dentro de LegalMonetaryTotal -- PayableAmount
  // sigue siendo el total con impuestos, la retención es informativa /
  // afecta el pago real por fuera de este total.
  const payableAmount = taxInclusiveAmount;

  const sellerDv = computeNitCheckDigit(input.seller.documentNumber);
  const buyerDv = computeNitCheckDigit(input.buyer.documentNumber);

  const cufe = await computeCufe({
    numFac: input.invoiceId,
    fecFac: input.issueDate,
    horFac: input.issueTime,
    valFac: subtotal,
    valImp1Iva: ivaTotal,
    valImp2Inc: incTotal,
    valImp3Ica: icaTotal,
    valTot: taxInclusiveAmount,
    nitOfe: input.seller.documentNumber,
    numAdq: input.buyer.documentNumber,
    claveTecnica: input.technicalKey,
    tipoAmbiente: input.environment,
  });

  const softwareSecurityCode = await computeSoftwareSecurityCode(input.softwareId, input.softwarePin, input.invoiceId);

  const qrHost = input.environment === 1 ? "https://catalogo-vpfe.dian.gov.co" : "https://catalogo-vpfe-hab.dian.gov.co";
  const qrContent = [
    `NroFactura=${input.invoiceId}`,
    `NitFacturador=${input.seller.documentNumber}`,
    `NitAdquiriente=${input.buyer.documentNumber}`,
    `FechaFactura=${input.issueDate}`,
    `ValorTotalFactura=${money(payableAmount)}`,
    `CUFE=${cufe}`,
    `URL=${qrHost}/document/searchqr?documentkey=${cufe}`,
  ].join("\n");

  const taxTotalBlocks = Array.from(taxGroupsByCode.keys())
    .sort((a, b) => TAX_CODE_ORDER.indexOf(a) - TAX_CODE_ORDER.indexOf(b))
    .map((code) => {
      const groups = taxGroupsByCode.get(code)!;
      const codeAmount = groups.reduce((sum, g) => sum + g.amount, 0);
      const subtotalsXml = groups
        .map(
          (g) => `
      <cac:TaxSubtotal>
         <cbc:TaxableAmount currencyID="${input.currency}">${money(g.taxable)}</cbc:TaxableAmount>
         <cbc:TaxAmount currencyID="${input.currency}">${money(g.amount)}</cbc:TaxAmount>
         <cac:TaxCategory>
            <cbc:Percent>${g.rate.toFixed(2)}</cbc:Percent>
            <cac:TaxScheme>
               <cbc:ID>${code}</cbc:ID>
               <cbc:Name>${TAX_SCHEME_NAME[code]}</cbc:Name>
            </cac:TaxScheme>
         </cac:TaxCategory>
      </cac:TaxSubtotal>`,
        )
        .join("");
      return `
   <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${input.currency}">${money(codeAmount)}</cbc:TaxAmount>${subtotalsXml}
   </cac:TaxTotal>`;
    })
    .join("");

  const withholdingBlock =
    input.withholdings.length === 0
      ? ""
      : `
   <cac:WithholdingTaxTotal>
      <cbc:TaxAmount currencyID="${input.currency}">${money(withholdingTotal)}</cbc:TaxAmount>${input.withholdings
        .map(
          (w) => `
      <cac:TaxSubtotal>
         <cbc:TaxableAmount currencyID="${input.currency}">${money(w.base)}</cbc:TaxableAmount>
         <cbc:TaxAmount currencyID="${input.currency}">${money(w.amount)}</cbc:TaxAmount>
         <cac:TaxCategory>
            <cbc:Percent>${w.rate.toFixed(2)}</cbc:Percent>
            <cac:TaxScheme>
               <cbc:ID>${w.code}</cbc:ID>
               <cbc:Name>${TAX_SCHEME_NAME[w.code] ?? w.code}</cbc:Name>
            </cac:TaxScheme>
         </cac:TaxCategory>
      </cac:TaxSubtotal>`,
        )
        .join("")}
   </cac:WithholdingTaxTotal>`;

  const linesXml = input.lines
    .map((line) => {
      const lineTax = line.tax
        ? `
      <cac:TaxTotal>
         <cbc:TaxAmount currencyID="${input.currency}">${money(line.tax.taxAmount)}</cbc:TaxAmount>
         <cac:TaxSubtotal>
            <cbc:TaxableAmount currencyID="${input.currency}">${money(line.tax.taxableAmount)}</cbc:TaxableAmount>
            <cbc:TaxAmount currencyID="${input.currency}">${money(line.tax.taxAmount)}</cbc:TaxAmount>
            <cac:TaxCategory>
               <cbc:Percent>${line.tax.rate.toFixed(2)}</cbc:Percent>
               <cac:TaxScheme>
                  <cbc:ID>${line.tax.code}</cbc:ID>
                  <cbc:Name>${TAX_SCHEME_NAME[line.tax.code]}</cbc:Name>
               </cac:TaxScheme>
            </cac:TaxCategory>
         </cac:TaxSubtotal>
      </cac:TaxTotal>`
        : "";
      // Precio unitario SIN impuesto -- se deriva del mismo monto neto ya
      // usado arriba (netAmount/cantidad), no de line.unitPrice (que viene
      // CON impuesto incluido) ni de una segunda extracción de impuesto
      // independiente -- evita que Price/PriceAmount y LineExtensionAmount
      // queden calculados por dos caminos que puedan desalinearse por
      // redondeo.
      const netAmount = netLineAmount(line);
      const netUnitPrice = line.quantity > 0 ? netAmount / line.quantity : netAmount;
      // cac:SellersItemIdentification (FAZ06/07) -- código PROPIO del
      // vendedor, no exige ningún estándar externo acreditado (ver el
      // comentario de cabecera sobre por qué no se usa StandardItemIdentification).
      const sellersItemIdentificationXml = line.sku
        ? `
         <cac:SellersItemIdentification>
            <cbc:ID>${esc(line.sku)}</cbc:ID>
         </cac:SellersItemIdentification>`
        : "";
      return `
   <cac:InvoiceLine>
      <cbc:ID>${line.id}</cbc:ID>
      <cbc:InvoicedQuantity unitCode="EA">${line.quantity.toFixed(6)}</cbc:InvoicedQuantity>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${money(netAmount)}</cbc:LineExtensionAmount>${lineTax}
      <cac:Item>
         <cbc:Description>${esc(line.description)}</cbc:Description>${sellersItemIdentificationXml}
      </cac:Item>
      <cac:Price>
         <cbc:PriceAmount currencyID="${input.currency}">${money(netUnitPrice)}</cbc:PriceAmount>
         <cbc:BaseQuantity unitCode="EA">1.000000</cbc:BaseQuantity>
      </cac:Price>
   </cac:InvoiceLine>`;
    })
    .join("");

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:ext="urn:oasis:names:specification:ubl:schema:xsd:CommonExtensionComponents-2" xmlns:sts="dian:gov:co:facturaelectronica:Structures-2-1" xmlns:xades="http://uri.etsi.org/01903/v1.3.2#" xmlns:xades141="http://uri.etsi.org/01903/v1.4.1#" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2     http://docs.oasis-open.org/ubl/os-UBL-2.1/xsd/maindoc/UBL-Invoice-2.1.xsd">
   <ext:UBLExtensions>
      <ext:UBLExtension>
         <ext:ExtensionContent>
            <sts:DianExtensions>
               <sts:InvoiceControl>
                  <sts:InvoiceAuthorization>${esc(input.resolution.number)}</sts:InvoiceAuthorization>
                  <sts:AuthorizationPeriod>
                     <cbc:StartDate>${input.resolution.validFrom}</cbc:StartDate>
                     <cbc:EndDate>${input.resolution.validUntil}</cbc:EndDate>
                  </sts:AuthorizationPeriod>
                  <sts:AuthorizedInvoices>
                     <sts:Prefix>${esc(input.resolution.prefix)}</sts:Prefix>
                     <sts:From>${esc(input.resolution.rangeFrom)}</sts:From>
                     <sts:To>${esc(input.resolution.rangeTo)}</sts:To>
                  </sts:AuthorizedInvoices>
               </sts:InvoiceControl>
               <sts:InvoiceSource>
                  <cbc:IdentificationCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listSchemeURI="urn:oasis:names:specification:ubl:codelist:gc:CountryIdentificationCode-2.1">CO</cbc:IdentificationCode>
               </sts:InvoiceSource>
               <sts:SoftwareProvider>
                  <sts:ProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="${sellerDv}" schemeName="31">${esc(input.seller.documentNumber)}</sts:ProviderID>
                  <sts:SoftwareID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${esc(input.softwareId)}</sts:SoftwareID>
               </sts:SoftwareProvider>
               <sts:SoftwareSecurityCode schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)">${softwareSecurityCode}</sts:SoftwareSecurityCode>
               <sts:AuthorizationProvider>
                  <sts:AuthorizationProviderID schemeAgencyID="195" schemeAgencyName="CO, DIAN (Dirección de Impuestos y Aduanas Nacionales)" schemeID="${computeNitCheckDigit(input.authorizationProviderNit)}" schemeName="31">${esc(input.authorizationProviderNit)}</sts:AuthorizationProviderID>
               </sts:AuthorizationProvider>
               <sts:QRCode>${esc(qrContent)}</sts:QRCode>
            </sts:DianExtensions>
         </ext:ExtensionContent>
      </ext:UBLExtension>
      <ext:UBLExtension><ext:ExtensionContent/></ext:UBLExtension>
   </ext:UBLExtensions>
   <cbc:UBLVersionID>UBL 2.1</cbc:UBLVersionID>
   <cbc:CustomizationID>10</cbc:CustomizationID>
   <cbc:ProfileID>DIAN 2.1: Factura Electrónica de Venta</cbc:ProfileID>
   <cbc:ProfileExecutionID>${input.environment}</cbc:ProfileExecutionID>
   <cbc:ID>${esc(input.invoiceId)}</cbc:ID>
   <cbc:UUID schemeID="${input.environment}" schemeName="CUFE-SHA384">${cufe}</cbc:UUID>
   <cbc:IssueDate>${input.issueDate}</cbc:IssueDate>
   <cbc:IssueTime>${input.issueTime}</cbc:IssueTime>
   <cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>
   <cbc:DocumentCurrencyCode listAgencyID="6" listAgencyName="United Nations Economic Commission for Europe" listID="ISO 4217 Alpha">${input.currency}</cbc:DocumentCurrencyCode>
   <cbc:LineCountNumeric>${input.lines.length}</cbc:LineCountNumeric>${partyBlock("cac:AccountingSupplierParty", input.seller, sellerDv, input.resolution.prefix)}${partyBlock("cac:AccountingCustomerParty", input.buyer, buyerDv)}
   <cac:PaymentMeans>
      <cbc:ID>${esc(input.payment.meansId)}</cbc:ID>
      <cbc:PaymentMeansCode>${esc(input.payment.meansCode)}</cbc:PaymentMeansCode>
   </cac:PaymentMeans>${taxTotalBlocks}${withholdingBlock}
   <cac:LegalMonetaryTotal>
      <cbc:LineExtensionAmount currencyID="${input.currency}">${money(subtotal)}</cbc:LineExtensionAmount>
      <cbc:TaxExclusiveAmount currencyID="${input.currency}">${money(subtotal)}</cbc:TaxExclusiveAmount>
      <cbc:TaxInclusiveAmount currencyID="${input.currency}">${money(taxInclusiveAmount)}</cbc:TaxInclusiveAmount>
      <cbc:PayableAmount currencyID="${input.currency}">${money(payableAmount)}</cbc:PayableAmount>
   </cac:LegalMonetaryTotal>${linesXml}
</Invoice>`;

  return { xml, cufe };
}
