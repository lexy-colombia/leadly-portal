/** Oráculo público del CUFE/CUDE: los XML de ejemplo OFICIALES de la DIAN
 * (functions/_shared/invoicing/dian-reference/ejemplos-xml) traen en
 * `cbc:Note` la cadena en claro que produce su `cbc:UUID`, incluida la clave
 * técnica de muestra del Anexo (no es un secreto). Sirve para probar el
 * algoritmo de cufe.ts sin ningún dato ni secreto de producción. */
import "../../functions/_shared/invoicing/nodeCompatShim.ts";
import { assertEquals } from "jsr:@std/assert@1";
import { computeCude, computeCufe } from "../../functions/_shared/invoicing/cufe.ts";

const DIR = new URL("../../functions/_shared/invoicing/dian-reference/ejemplos-xml/", import.meta.url);

async function sha384Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-384", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function extract(xml: string) {
  const note = xml.match(/<cbc:Note>(\d?[A-Z]*\d[0-9A-Za-z.\-:]{50,})<\/cbc:Note>/)?.[1];
  const uuid = xml.match(/<cbc:UUID\s+schemeID="\d"\s+schemeName="CU[FD]E-SHA384">\s*([0-9a-f]{96})\s*</)?.[1];
  if (!note || !uuid) throw new Error("no se encontró Note/UUID");
  return { note, uuid };
}

// Descompone la cadena en sus campos (formato fijo del Anexo 11.2/11.4).
function parseNote(note: string, secretLen: number) {
  const m = note.match(/^([A-Za-z]*\d+?)(\d{4}-\d{2}-\d{2})(\d{2}:\d{2}:\d{2}-05:00)(\d+\.\d{2})01(\d+\.\d{2})04(\d+\.\d{2})03(\d+\.\d{2})(\d+\.\d{2})(\d+)$/);
  if (!m) throw new Error("nota con formato inesperado: " + note);
  const tail = m[9]; // nitOfe + numAdq + secreto + ambiente
  return { m, tail, secretLen };
}

for (const file of ["Generica.xml", "EmisorAutoretenedor.xml", "Exento de IVA.xml", "CreditNote.xml", "DebitNote.xml"]) {
  Deno.test(`oráculo DIAN: SHA-384(Note) == UUID en ${file}`, async () => {
    const xml = await Deno.readTextFile(new URL(file, DIR));
    const { note, uuid } = extract(xml);
    assertEquals(await sha384Hex(note), uuid);
  });
}

Deno.test("oráculo DIAN: computeCufe() reproduce el UUID de Generica.xml", async () => {
  const xml = await Deno.readTextFile(new URL("Generica.xml", DIR));
  const { note, uuid } = extract(xml);
  // SETP990000002 2019-06-20 09:15:23-05:00 12600.06 01 2424.01 04 0.00 03 30.00 14024.07 900508908 900108281 <key 40> 2
  const m = note.match(/^(SETP\d+)(\d{4}-\d{2}-\d{2})(\d{2}:\d{2}:\d{2}-05:00)(\d+\.\d{2})01(\d+\.\d{2})04(\d+\.\d{2})03(\d+\.\d{2})(\d+\.\d{2})(\d{9})(\d{9})([0-9a-f]{40})(\d)$/)!;
  assertEquals(!!m, true);
  const cufe = await computeCufe({
    numFac: m[1], fecFac: m[2], horFac: m[3], valFac: Number(m[4]),
    valImp1Iva: Number(m[5]), valImp2Inc: Number(m[6]), valImp3Ica: Number(m[7]),
    valTot: Number(m[8]), nitOfe: m[9], numAdq: m[10], claveTecnica: m[11], tipoAmbiente: Number(m[12]) as 1 | 2,
  });
  assertEquals(cufe, uuid);
});

Deno.test("oráculo DIAN: computeCude() reproduce el UUID de CreditNote.xml y DebitNote.xml", async () => {
  for (const file of ["CreditNote.xml", "DebitNote.xml"]) {
    const xml = await Deno.readTextFile(new URL(file, DIR));
    const { note, uuid } = extract(xml);
    // NC3 2019-06-21 09:15:23-05:00 12600.06 01 0.00? ... 14994.07 900508908 900108281 <pin> 2
    const m = note.match(/^([A-Z]+\d+)(\d{4}-\d{2}-\d{2})(\d{2}:\d{2}:\d{2}-05:00)(\d+\.\d{2})01(\d+\.\d{2})04(\d+\.\d{2})03(\d+\.\d{2})(\d+\.\d{2})(\d{9})(\d{9})(\d+)(\d)$/)!;
    assertEquals(!!m, true, file);
    const cude = await computeCude({
      numFac: m[1], fecFac: m[2], horFac: m[3], valFac: Number(m[4]),
      valImp1Iva: Number(m[5]), valImp2Inc: Number(m[6]), valImp3Ica: Number(m[7]),
      valTot: Number(m[8]), nitOfe: m[9], numAdq: m[10], softwarePin: m[11], tipoAmbiente: Number(m[12]) as 1 | 2,
    });
    assertEquals(cude, uuid, file);
  }
});

// parseNote queda como utilidad de diagnóstico si un ejemplo nuevo cambia de formato.
void parseNote;
