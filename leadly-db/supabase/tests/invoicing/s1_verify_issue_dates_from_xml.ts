/**
 * S1 · Contraste de issue_date_co / issue_time_co con el XML REAL guardado.
 *
 * SOLO LECTURA. Lee de public.sales_invoices y public.sales_credit_notes
 * (vía PostgREST) los documentos aceptados con XML conservado, descarga cada
 * XML del bucket privado `sales-documents` y compara el `cbc:IssueDate` /
 * `cbc:IssueTime` realmente declarados (y, en notas crédito, la fecha de la
 * factura referenciada en cac:BillingReference) contra lo que la migración
 * 20261009180200 persiste para ese documento (regla "con XML" de s1_decl):
 *   antes del corte (2026-09-10 14:52:16-05)      -> fecha y hora UTC, sufijo -05:00
 *   en las 24 h siguientes (ventana de despliegue) -> hora NULL; fecha solo si UTC == Colombia
 *   después                                        -> reloj de pared de Colombia
 *
 * Por cada documento imprime OK / DIFIERE / COMPLETA y, cuando hay algo que
 * escribir, una sentencia UPDATE PROPUESTA contra invoicing.documents. NO LA
 * EJECUTA: revisarlas y correrlas a mano (el trigger solo las deja pasar si
 * la fuente actual empieza por 'derived' y la nueva es verified_xml|corrected,
 * y registra un evento por cada una).
 *
 * Uso (necesita la service role key; NO se commitea):
 *   SUPABASE_URL=https://<ref>.supabase.co SUPABASE_SERVICE_ROLE_KEY=... \
 *     deno run --allow-env --allow-net s1_verify_issue_dates_from_xml.ts
 */
const CUTOFF = Date.parse("2026-09-10T14:52:16-05:00");
const WINDOW_MS = 24 * 3600_000;

export interface Declared {
  date: string | null;
  time: string | null;
}

/** Lo que persiste la migración para un documento CON XML. */
export function expectedPersisted(issueDateIso: string): Declared & { source: string } {
  const t = Date.parse(issueDateIso);
  const utc = new Date(t).toISOString();
  const co = new Date(t - 5 * 3600_000).toISOString();
  const dUtc = utc.slice(0, 10);
  const dCo = co.slice(0, 10);
  if (t < CUTOFF) return { date: dUtc, time: utc.slice(11, 19) + "-05:00", source: "derived_utc_pre_fix" };
  if (t < CUTOFF + WINDOW_MS) {
    return { date: dUtc === dCo ? dCo : null, time: null, source: "derived_unverified_window" };
  }
  return { date: dCo, time: co.slice(11, 19) + "-05:00", source: "derived_colombia" };
}

export function extractDeclared(xml: string): { date: string | null; time: string | null; referencedDate: string | null } {
  const billingRef = xml.match(/<cac:BillingReference>[\s\S]*?<\/cac:BillingReference>/)?.[0] ?? "";
  // La fecha propia es la primera cbc:IssueDate FUERA del BillingReference.
  const outside = billingRef ? xml.replace(billingRef, "") : xml;
  return {
    date: outside.match(/<cbc:IssueDate>([^<]+)<\/cbc:IssueDate>/)?.[1] ?? null,
    time: outside.match(/<cbc:IssueTime>([^<]+)<\/cbc:IssueTime>/)?.[1] ?? null,
    referencedDate: billingRef.match(/<cbc:IssueDate>([^<]+)<\/cbc:IssueDate>/)?.[1] ?? null,
  };
}

export type Verdict = "OK" | "COMPLETA" | "DIFIERE";

export function judge(expected: Declared, declared: Declared): Verdict {
  if (declared.date === null || declared.time === null) return "DIFIERE";
  const dateOk = expected.date === null || expected.date === declared.date;
  const timeOk = expected.time === null ? null : expected.time === declared.time;
  if (!dateOk || timeOk === false) return "DIFIERE";
  return expected.date === declared.date && timeOk === true ? "OK" : "COMPLETA";
}

export function proposeUpdate(
  legacySource: "sales_invoices" | "sales_credit_notes",
  legacyId: string,
  declared: { date: string | null; time: string | null; referencedDate: string | null },
  verdict: Verdict,
): string {
  const source = verdict === "DIFIERE" ? "corrected" : "verified_xml";
  const sets = [`issue_date_co = '${declared.date}'`, `issue_time_co = '${declared.time}'`];
  if (legacySource === "sales_credit_notes" && declared.referencedDate) {
    sets.push(`referenced_issue_date_declared = '${declared.referencedDate}'`);
  }
  sets.push(`issue_datetime_source = '${source}'`);
  return `update invoicing.documents set ${sets.join(", ")} where legacy_source = '${legacySource}' ` +
    `and legacy_id = '${legacyId}' and issue_datetime_source like 'derived%';`;
}

interface Row {
  id: string;
  issue_date: string;
  xml_storage_path: string;
  label: string;
}

async function main() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) throw new Error("Faltan SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const headers = { apikey: key, Authorization: `Bearer ${key}` };

  async function list(table: "sales_invoices" | "sales_credit_notes"): Promise<Row[]> {
    const cols = table === "sales_invoices"
      ? "id,invoice_prefix,invoice_number,issue_date,xml_storage_path"
      : "id,credit_note_prefix,credit_note_number,issue_date,xml_storage_path";
    const res = await fetch(
      `${url}/rest/v1/${table}?select=${cols}&status=eq.accepted&xml_storage_path=not.is.null` +
        `&issue_date=not.is.null&order=issue_date.asc&limit=5000`,
      { headers },
    );
    if (!res.ok) throw new Error(`PostgREST ${table} ${res.status}: ${await res.text()}`);
    // deno-lint-ignore no-explicit-any
    return (await res.json()).map((r: any) => ({
      id: r.id,
      issue_date: r.issue_date,
      xml_storage_path: r.xml_storage_path,
      label: table === "sales_invoices"
        ? `${r.invoice_prefix}${r.invoice_number}`
        : `${r.credit_note_prefix}${r.credit_note_number}`,
    }));
  }

  const counts = { OK: 0, COMPLETA: 0, DIFIERE: 0, NO_DESCARGA: 0 };
  const updates: string[] = [];
  for (const table of ["sales_invoices", "sales_credit_notes"] as const) {
    for (const r of await list(table)) {
      const res = await fetch(`${url}/storage/v1/object/sales-documents/${r.xml_storage_path}`, { headers });
      if (!res.ok) {
        counts.NO_DESCARGA++;
        console.log(`NO_DESCARGA ${table} ${r.label} ${r.id} (${res.status})`);
        continue;
      }
      const declared = extractDeclared(await res.text());
      const expected = expectedPersisted(r.issue_date);
      const verdict = judge(expected, declared);
      counts[verdict]++;
      if (verdict !== "OK") {
        console.log(
          `${verdict} ${table} ${r.label} ${r.id} issue_date=${r.issue_date} ` +
            `xml=${declared.date} ${declared.time} esperado(migracion)=${expected.date} ${expected.time} [${expected.source}]`,
        );
        if (declared.date && declared.time) updates.push(proposeUpdate(table, r.id, declared, verdict));
      }
    }
  }
  console.log(`\nOK=${counts.OK} COMPLETA=${counts.COMPLETA} DIFIERE=${counts.DIFIERE} no_descargaron=${counts.NO_DESCARGA}`);
  if (updates.length) {
    console.log("\n-- UPDATES PROPUESTOS (NO ejecutados; revisar y correr contra la base DESPUÉS de la copia):");
    for (const u of updates) console.log(u);
  }
  console.log(
    "\nNOTA: los aceptados SIN XML (FE12, SETP990000001, FE57…) no se pueden verificar con este script:\n" +
      "quedan con issue_time_co NULL / fuente derived_unverified_no_xml. Alternativa: recomputar el CUFE\n" +
      "con cufe_oracle_test.ts probando ambas horas candidatas (el CUFE incluye IssueDate+IssueTime).",
  );
}

if (import.meta.main) await main();
