// Pruebas de la escritura de la etiqueta "no contactar" (update_client_profile.do_not_contact).
// Rutas sobreescribibles por env para la mutacion (run.sh).
const FN = new URL("../../functions/", import.meta.url);
const P = (envName: string, rel: string) => Deno.env.get(envName) ?? new URL(rel, FN).pathname;
const tagsPath = P("TAGS_PATH", "_shared/clientTags.ts");
const aiToolsPath = P("AITOOLS_PATH", "_shared/aiTools.ts");
const indexPath = P("INDEX_PATH", "whatsapp-ai-tools/index.ts");
const tags = await import(`file://${tagsPath}`);
const { AI_TOOLS } = await import(`file://${aiToolsPath}`);
const { updateClientProfile, withDoNotContactTag, DO_NOT_CONTACT_TAG } = tags;

function assert(c: unknown, m: string) { if (!c) throw new Error("ASSERT: " + m); }
function eq(a: unknown, b: unknown, m: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`EQ ${m}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// Cliente falso: tabla clients en memoria, soporta select/update/eq/is/single/maybeSingle.
function fakeClient(rows: Record<string, unknown>[]) {
  const writes: { patch: Record<string, unknown>; where: Record<string, unknown> }[] = [];
  const client = {
    writes,
    from(table: string) {
      assert(table === "clients", "solo clients");
      const st: { mode: string; patch?: Record<string, unknown>; where: Record<string, unknown>; notDeleted: boolean } = { mode: "select", where: {}, notDeleted: false };
      const match = () => rows.filter((r) => Object.entries(st.where).every(([k, v]) => r[k] === v) && (!st.notDeleted || r.deleted_at == null));
      const q = {
        select() { return q; },
        update(patch: Record<string, unknown>) { st.mode = "update"; st.patch = patch; return q; },
        eq(k: string, v: unknown) { st.where[k] = v; return q; },
        is(k: string, v: unknown) { if (k === "deleted_at" && v === null) st.notDeleted = true; return q; },
        single() { return q.maybeSingle(); },
        maybeSingle() { return Promise.resolve(run()); },
        then(res: (v: unknown) => unknown) { return Promise.resolve(run()).then(res); },
      };
      function run() {
        const m = match();
        if (st.mode === "update") {
          for (const r of m) Object.assign(r, st.patch);
          writes.push({ patch: st.patch!, where: { ...st.where } });
        }
        return { data: m[0] ?? null, error: null };
      }
      return q;
    },
  };
  return client;
}
const T = "t1", OT = "t2";
const mk = () => [
  { id: "c1", tenant_id: T, tags: ["administrador", "vip"], full_name: "Ana", document_type: null, document_number: null, email: null, deleted_at: null },
  { id: "c2", tenant_id: T, tags: [], full_name: "Beto", document_type: null, document_number: null, email: null, deleted_at: null },
  { id: "c1", tenant_id: OT, tags: ["x"], full_name: "Otro tenant mismo id", document_type: null, document_number: null, email: null, deleted_at: null },
];

const tests: [string, () => Promise<void> | void][] = [
  ["constante literal 'no contactar'", () => eq(DO_NOT_CONTACT_TAG, "no contactar", "tag")],
  ["withDoNotContactTag agrega y conserva administrador", () => {
    const r = withDoNotContactTag(["administrador", "vip"]);
    eq(r.tags, ["administrador", "vip", "no contactar"], "tags"); assert(r.added, "added");
  }],
  ["withDoNotContactTag idempotente (incl. variantes de mayuscula)", () => {
    eq(withDoNotContactTag(["No Contactar"]).added, false, "added");
    eq(withDoNotContactTag(["no contactar"]).tags, ["no contactar"], "sin duplicar");
  }],
  ["withDoNotContactTag con null/undefined", () => { eq(withDoNotContactTag(null).tags, ["no contactar"], "null"); eq(withDoNotContactTag(undefined).tags, ["no contactar"], "undef"); }],
  ["do_not_contact:true solo -> etiqueta, conserva administrador, devuelve do_not_contact:true", async () => {
    const rows = mk(); const c = fakeClient(rows);
    const r = await updateClientProfile(c, T, "c1", { do_not_contact: true });
    eq(r.do_not_contact, true, "flag"); eq(r.updated, true, "updated");
    eq(rows[0].tags, ["administrador", "vip", "no contactar"], "tags c1");
    eq(rows[1].tags, [], "c2 intacto"); eq(rows[2].tags, ["x"], "otro tenant intacto");
    eq(rows[0].full_name, "Ana", "perfil intacto");
  }],
  ["idempotente: 2a llamada no escribe ni duplica", async () => {
    const rows = mk(); const c = fakeClient(rows);
    await updateClientProfile(c, T, "c1", { do_not_contact: true });
    const n = c.writes.length;
    await updateClientProfile(c, T, "c1", { do_not_contact: true });
    eq(c.writes.length, n, "sin escrituras nuevas");
    eq(rows[0].tags.filter((t: string) => t === "no contactar").length, 1, "una sola");
  }],
  ["do_not_contact false/ausente/'true'/1 no escribe etiqueta (y sin campos falla)", async () => {
    for (const v of [false, undefined, "true", 1, "no contactar"]) {
      const rows = mk(); const c = fakeClient(rows);
      let threw = false;
      try { await updateClientProfile(c, T, "c1", { do_not_contact: v }); } catch { threw = true; }
      assert(threw, `debe fallar sin campos (${String(v)})`);
      eq(c.writes.length, 0, "sin escrituras"); eq(rows[0].tags, ["administrador", "vip"], "tags");
    }
    const rows = mk(); const c = fakeClient(rows);
    const r = await updateClientProfile(c, T, "c1", { email: "a@b.co", do_not_contact: false });
    eq(r.do_not_contact, undefined, "no flag"); eq(rows[0].tags, ["administrador", "vip"], "tags intactos"); eq(rows[0].email, "a@b.co", "email");
  }],
  ["parametros desconocidos / intento de nombre de etiqueta se ignoran", async () => {
    const rows = mk(); const c = fakeClient(rows);
    await updateClientProfile(c, T, "c1", { do_not_contact: true, tag: "administrador", tags: ["admin"], label: "x", etiqueta: "y", tag_name: "z", do_not_contact_tag: "hack" });
    eq(rows[0].tags, ["administrador", "vip", "no contactar"], "solo la constante");
    const rows2 = mk(); const c2 = fakeClient(rows2);
    let threw = false;
    try { await updateClientProfile(c2, T, "c2", { tag: "administrador", tags: ["administrador"] }); } catch { threw = true; }
    assert(threw, "sin do_not_contact ni campos falla"); eq(rows2[1].tags, [], "c2 sin tags");
  }],
  ["campos de perfil + do_not_contact juntos", async () => {
    const rows = mk(); const c = fakeClient(rows);
    const r = await updateClientProfile(c, T, "c2", { email: "b@b.co", do_not_contact: true });
    eq(r.email, "b@b.co", "email"); eq(rows[1].tags, ["no contactar"], "tag");
  }],
  ["aislamiento de tenant: tenant ajeno o contacto borrado -> error y sin escritura", async () => {
    const rows = mk(); const c = fakeClient(rows);
    let threw = false;
    try { await updateClientProfile(c, "t-inexistente", "c2", { do_not_contact: true }); } catch { threw = true; }
    assert(threw, "tenant ajeno falla"); eq(c.writes.length, 0, "sin escrituras"); eq(rows[1].tags, [], "c2");
    rows[1].deleted_at = "2026-01-01";
    threw = false;
    try { await updateClientProfile(c, T, "c2", { do_not_contact: true }); } catch { threw = true; }
    assert(threw, "borrado falla"); eq(rows[1].tags, [], "c2 borrado intacto");
  }],
  ["definicion de la tool: solo 4 strings + do_not_contact boolean sin enum", () => {
    const t = AI_TOOLS.find((x: { name: string }) => x.name === "update_client_profile");
    assert(t, "tool existe");
    const props = t.parameters.properties as Record<string, { type: string; enum?: unknown }>;
    eq(Object.keys(props).sort(), ["document_number", "document_type", "do_not_contact", "email", "full_name"].sort(), "claves");
    eq(props.do_not_contact.type, "boolean", "boolean"); assert(!props.do_not_contact.enum, "sin enum");
    eq(t.parameters.required, [], "required vacio");
    assert(/no contactar/.test(t.description), "description documenta");
  }],
  ["ninguna otra tool de IA tiene parametro de etiqueta", () => {
    for (const t of AI_TOOLS) {
      if (t.name === "update_client_profile") continue;
      for (const k of Object.keys(t.parameters.properties ?? {})) assert(!/(^|_)(tags?|etiquetas?)(_|$)/i.test(k), `${t.name}.${k}`);
    }
  }],
  ["codigo: la unica escritura de tags es la constante (clientTags.ts) y index delega con parameters completo", async () => {
    const src = await Deno.readTextFile(tagsPath);
    const writes = src.match(/\.update\(\{[^}]*\}\)/g) ?? [];
    assert(writes.length === 1 && /tags: next\.tags/.test(writes[0]), "un unico update({ tags: next.tags })");
    assert(/withDoNotContactTag\(data\.tags\)/.test(src), "next sale de withDoNotContactTag");
    assert(/\[\.\.\.tags, DO_NOT_CONTACT_TAG\]/.test(src), "append de la constante");
    assert(/do_not_contact === true/.test(src), "solo booleano true");
    assert(!/parameters\.(tag|tags|label|etiqueta)/.test(src), "no lee tag del modelo");
    const idx = await Deno.readTextFile(indexPath);
    assert(!/tags\s*:/.test(idx.slice(idx.indexOf('case "update_client_profile"'), idx.indexOf('case "list_contact_addresses"'))), "index no escribe tags");
    assert(/updateClientProfile\(adminClient, tenantId, contactId, parameters\)/.test(idx), "index delega");
  }],
];

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; console.log("FAIL " + name + " :: " + (e as Error).message); }
}
console.log(`RESUMEN ${pass} PASS, ${fail} FAIL`);
Deno.exit(fail === 0 && pass > 0 ? 0 : 1);
