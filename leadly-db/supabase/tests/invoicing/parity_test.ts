/** Harness de paridad (S0). Ver harness.ts para el alcance y las restricciones.
 *
 * Qué verifica por documento:
 *  1. UUID del XML == CUFE/CUDE devuelto por el builder == hash recomputado con
 *     una implementación independiente (Anexo 11.2/11.4) sobre los valores
 *     QUE EL PROPIO XML IMPRIME (la clase de bug FAD06).
 *  2. Si hay `storedCufe` y clave técnica/PIN: igualdad con lo guardado en DB.
 *  3. Coherencia de totales/impuestos (FAU04: bases de línea == cabecera).
 *  4. Estructura estable: snapshot del XML sin firmar (solo fixtures sintéticos).
 *  5. Firma con certificado AUTOFIRMADO: verifySignedInvoiceXml == true, 3
 *     ds:Reference, SigningTime en -05:00 y misma fecha que cbc:IssueDate
 *     (FAD09e).
 *
 * Fixtures reales: progress/fixtures_private/*.json (git-ignorado). Si no hay,
 * solo corren los sintéticos y se avisa.
 *
 * Correr:  deno test -A leadly-db/supabase/tests/invoicing/
 * Regenerar snapshots: S0_UPDATE_SNAPSHOTS=1 deno test -A ...
 */
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import {
  buildCreditNoteXml, buildInvoiceXml, creditNoteFixtureToInput, extractFacts, invoiceFixtureToInput, makeSelfSignedCertificate,
  parseXml, specHash, type Fixture,
} from "./harness.ts";
import { SYNTHETIC_CREDIT_NOTES, SYNTHETIC_INVOICES } from "./fixtures_synthetic.ts";
import { signInvoiceXml, verifySignedInvoiceXml } from "../../functions/_shared/invoicing/signInvoiceXml.ts";
import { colombiaDateOfInstant, colombiaIssueMoment } from "../../functions/_shared/invoicing/colombiaTime.ts";

const UPDATE = Deno.env.get("S0_UPDATE_SNAPSHOTS") === "1";
const SNAP_DIR = new URL("./snapshots/", import.meta.url);
const PRIVATE_DIR = new URL("../../../../progress/fixtures_private/", import.meta.url);

let certPromise: ReturnType<typeof makeSelfSignedCertificate> | null = null;
const cert = () => (certPromise ??= makeSelfSignedCertificate());

async function loadPrivate(): Promise<Fixture[]> {
  const out: Fixture[] = [];
  try {
    for await (const e of Deno.readDir(PRIVATE_DIR)) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      const parsed = JSON.parse(await Deno.readTextFile(new URL(e.name, PRIVATE_DIR)));
      out.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return out;
}

const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

async function checkFixture(fx: Fixture) {
  const { signingInstant } = fx.kind === "invoice" ? invoiceFixtureToInput(fx) : creditNoteFixtureToInput(fx);
  const moment = colombiaIssueMoment(signingInstant);
  let xml: string;
  let hash: string;
  let secret: string | null;
  let numFac: string;
  let stored: string | null;

  if (fx.kind === "invoice") {
    const built = invoiceFixtureToInput(fx);
    assertEquals(built.invalidRate, null, "FAX14: combinación tipo+tarifa inválida (el orquestador abortaría)");
    const r = await buildInvoiceXml(built.input);
    xml = r.xml; hash = r.cufe; secret = fx.secrets.technicalKey; numFac = built.input.invoiceId; stored = fx.storedCufe;
  } else {
    const built = creditNoteFixtureToInput(fx);
    const r = await buildCreditNoteXml(built.input);
    xml = r.xml; hash = r.cude; secret = fx.secrets.softwarePin; numFac = built.input.creditNoteId; stored = fx.storedCude;
  }

  const f = extractFacts(xml, fx.kind);
  assertEquals(f.id, numFac);
  assertEquals(f.uuid, hash, "UUID del XML != hash devuelto por el builder");
  assertEquals(f.issueDate, moment.issueDate);
  assertEquals(f.issueTime, moment.issueTime);
  assertEquals(f.lineCountNumeric, f.lineCount);

  // Totales / impuestos (FAU04).
  assert(near(f.lineExtension, f.lineSumExtension), `LineExtensionAmount ${f.lineExtension} != suma líneas ${f.lineSumExtension}`);
  const baseTotal = Object.values(f.lineSumTaxableByCode).reduce((a, b) => a + b, 0);
  assert(near(f.taxExclusive, baseTotal), `TaxExclusiveAmount ${f.taxExclusive} != suma de bases de línea ${baseTotal}`);
  for (const code of Object.keys(f.lineSumTaxableByCode)) {
    assert(near(f.headerTaxableByCode[code] ?? 0, f.lineSumTaxableByCode[code]), `base cabecera ${code} != suma líneas`);
  }
  assert(near(f.taxInclusive, f.lineExtension + f.headerTaxTotal), `TaxInclusive ${f.taxInclusive} != base+impuestos`);
  assert(near(f.payable, f.taxInclusive), "PayableAmount != TaxInclusiveAmount (sin retenciones)");
  if (fx.kind === "invoice") assert(f.qrContainsUuid, "el QR no contiene el CUFE");

  // Hash independiente sobre lo que el XML imprime.
  if (secret) {
    const seller = fx.seller.document_number!;
    const buyer = fx.buyer.document_number!;
    const spec = await specHash({
      numFac: f.id, fecFac: f.issueDate, horFac: f.issueTime, valFac: f.lineExtension,
      iva: f.headerTaxAmountByCode["01"] ?? 0, inc: f.headerTaxAmountByCode["04"] ?? 0, ica: f.headerTaxAmountByCode["03"] ?? 0,
      valTot: f.payable, nitOfe: seller, numAdq: buyer, secret, env: fx.isProduction ? 1 : 2,
    });
    assertEquals(spec, hash, "hash independiente != CUFE/CUDE del builder (divergencia entre lo impreso y lo hasheado)");
    if (stored) assertEquals(stored, hash, "CUFE/CUDE recalculado != el guardado en DB");
  }

  // Snapshot estructural (solo sintéticos: datos inventados, sin PII).
  if (fx.synthetic) {
    const file = new URL(`${fx.kind}__${fx.label}.xml`, SNAP_DIR);
    if (UPDATE) await Deno.writeTextFile(file, xml);
    else assertEquals(xml, await Deno.readTextFile(file), `snapshot distinto: ${fx.label} (S0_UPDATE_SNAPSHOTS=1 para regenerar si es intencional)`);
  }

  // Firma con certificado autofirmado de prueba.
  const c = await cert();
  const signed = await signInvoiceXml({ unsignedXml: xml, privateKey: c.privateKey, certificateDer: c.certificateDer, signingInstant });
  assertEquals(await verifySignedInvoiceXml(signed), true, "verifySignedInvoiceXml == false");
  const sdoc = parseXml(signed);
  assertEquals(sdoc.getElementsByTagName("ds:Reference").length, 3, "se esperaban 3 ds:Reference (doc, KeyInfo, SignedProperties)");
  const st = sdoc.getElementsByTagName("xades:SigningTime")[0]?.textContent ?? "";
  assertMatch(st, /-05:00$/);
  assertEquals(st.slice(0, 10), f.issueDate, "FAD09e: fecha de firma != cbc:IssueDate");
  return { f, hash, reconstructedAgainstStored: Boolean(stored && secret), hadSecret: Boolean(secret) };
}

for (const fx of [...SYNTHETIC_INVOICES, ...SYNTHETIC_CREDIT_NOTES]) {
  Deno.test(`paridad sintética [${fx.kind}] ${fx.label}`, async () => {
    await checkFixture(fx);
  });
}

const priv = await loadPrivate();
if (priv.length === 0) console.warn("[S0] progress/fixtures_private/ vacío o ausente: solo corren fixtures sintéticos.");
for (const fx of priv) {
  Deno.test(`paridad REAL [${fx.kind}] ${fx.label}`, async () => {
    const r = await checkFixture({ ...fx, synthetic: false });
    if (!r.hadSecret) console.warn(`[S0] ${fx.label}: sin clave técnica/PIN -> CUFE no reconstruible; solo estructura/firma/totales`);
  });
}

// ---- BF1: fecha de la factura referenciada en la NC = fecha de pared de Colombia ----

async function referencedDate(ncLabel: string): Promise<string> {
  const nc = SYNTHETIC_CREDIT_NOTES.find((x) => x.label === ncLabel)!;
  return creditNoteFixtureToInput(nc).input.referencedInvoice.issueDate;
}

Deno.test("BF1: NC sobre factura nocturna referencia la fecha que la factura declaró (CO), no el slice UTC", async () => {
  const nc = SYNTHETIC_CREDIT_NOTES.find((x) => x.label === "nc-referencia-factura-nocturna")!;
  const inv = SYNTHETIC_INVOICES.find((x) => x.label === "noche-cruza-dia-utc")!;
  const invXml = (await buildInvoiceXml(invoiceFixtureToInput(inv).input)).xml;
  const declared = extractFacts(invXml, "invoice").issueDate;
  assertEquals(declared, "2026-09-10");
  assertEquals(creditNoteFixtureToInput(nc).input.referencedInvoice.issueDate, declared);
});

Deno.test("BF1: caso FE371 (2026-10-09T03:17:18Z) referencia 2026-10-08", async () => {
  assertEquals(await referencedDate("nc-referencia-fe371"), "2026-10-08");
  // y el XML de la NC lo lleva en cac:BillingReference
  const nc = SYNTHETIC_CREDIT_NOTES.find((x) => x.label === "nc-referencia-fe371")!;
  const { xml } = await buildCreditNoteXml(creditNoteFixtureToInput(nc).input);
  assertEquals(xml.includes("<cbc:IssueDate>2026-10-08</cbc:IssueDate>"), true);
});

Deno.test("BF1: caso diurno sin cambio (13:30 CO == misma fecha UTC)", async () => {
  assertEquals(await referencedDate("nc-inc8"), "2026-09-10");
  assertEquals(await referencedDate("nc-sin-impuesto"), "2026-09-10");
});

Deno.test("BF1: colombiaDateOfInstant -- bordes y fallback", () => {
  assertEquals(colombiaDateOfInstant("2026-10-09T05:00:00+00:00"), "2026-10-09"); // 00:00 CO
  assertEquals(colombiaDateOfInstant("2026-10-09T04:59:59+00:00"), "2026-10-08"); // 23:59:59 CO
  assertEquals(colombiaDateOfInstant("2026-10-09T03:17:18.123456+00:00"), "2026-10-08"); // microsegundos PostgREST
  assertEquals(colombiaDateOfInstant(null), null);
  assertEquals(colombiaDateOfInstant("no-es-fecha"), null);
});
