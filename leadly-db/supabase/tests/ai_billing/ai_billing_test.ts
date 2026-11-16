// Pruebas puras (sin base) de las herramientas de IA de entrega y facturación (S4):
// resolveReference, saved_addresses/saved_profiles, gate de confirm_quote,
// validación de faltantes (la MISMA de buildFiscalBuyer), DIVIPOLA, catálogo de tools.
// Rutas sobreescribibles por env para las mutaciones (run.sh).
const FN = new URL("../../functions/", import.meta.url);
const P = (envName: string, rel: string) => Deno.env.get(envName) ?? new URL(rel, FN).pathname;
const modPath = P("MODULE_PATH", "_shared/ai/deliveryBillingTools.ts");
const indexPath = P("INDEX_PATH", "whatsapp-ai-tools/index.ts");
const aiToolsPath = P("AITOOLS_PATH", "_shared/aiTools.ts");
const m = await import(`file://${modPath}`);
const { AI_TOOLS, isToolAllowed, toolsForSkills } = await import(`file://${aiToolsPath}`);
const { buildFiscalBuyer, billingProfileMissing } = await import(`file://${P("PROFILE_PATH", "_shared/invoicing/clientBillingProfile.ts")}`);
const { evaluateFulfillmentAndBilling } = await import(`file://${P("FB_PATH", "_shared/orders/fulfillmentAndBilling.ts")}`);

function assert(c: unknown, msg: string) { if (!c) throw new Error("ASSERT: " + msg); }
function eq(a: unknown, b: unknown, msg: string) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`EQ ${msg}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); }

// Catálogo geográfico REAL: se parsea del archivo de migración que lo carga en producción.
const geoSql = await Deno.readTextFile(new URL("../../migrations/20260909240000_co_geo_catalog.sql", import.meta.url));
const deptsStart = geoSql.indexOf("insert into public.departments"), citiesStart = geoSql.indexOf("insert into public.cities");
const REAL_DEPTS: { code: string; name: string }[] = [...geoSql.slice(deptsStart, citiesStart).matchAll(/\('(\d+)', '((?:[^']|'')*)'\)/g)].map((x) => ({ code: x[1], name: x[2].replace(/''/g, "'") }));
const REAL_CITIES: { code: string; name: string; department_code: string }[] = [...geoSql.slice(citiesStart).matchAll(/\('(\d+)', '((?:[^']|'')*)', '(\d+)'\)/g)].map((x) => ({ code: x[1], name: x[2].replace(/''/g, "'"), department_code: x[3] }));

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const completeProfile = (over: Record<string, unknown> = {}) => ({
  id: "p1", tenant_id: "t1", client_id: "c1", label: "Personal", is_default: true,
  document_type_code: "13", document_number: "1020304050", legal_name: "Ana Pérez", email: "ana@x.co", phone: null,
  organization_type: "2", tax_level_code: "R-99-PN", tax_scheme_code: null, applies_withholding: false,
  address_line1: null, address_line2: null, country: null, state_code: null, city_code: null, state_province: null, city: null, ...over,
});

const tests: [string, () => void | Promise<void>][] = [
  // ---------------- resolveReference (elección por número de opción)
  ["resolveReference: vacío/null/undefined = none", () => {
    for (const v of [undefined, null, "", "   "]) eq(m.resolveReference([{ option: 1, id: "a" }], v).kind, "none", String(v));
  }],
  ["resolveReference: UUID se devuelve tal cual (no se confía, lo valida quien lo usa)", () => {
    eq(m.resolveReference([], UUID), { kind: "id", id: UUID }, "uuid");
  }],
  ["resolveReference: número de opción ('1', 2, 'opción 3', '#2')", () => {
    const items = [{ option: 1, id: "a" }, { option: 2, id: "b" }, { option: 3, id: "c" }];
    eq(m.resolveReference(items, "1"), { kind: "option", id: "a" }, "1");
    eq(m.resolveReference(items, 2), { kind: "option", id: "b" }, "2");
    eq(m.resolveReference(items, "opción 3"), { kind: "option", id: "c" }, "opcion 3");
    eq(m.resolveReference(items, "#2"), { kind: "option", id: "b" }, "#2");
  }],
  ["resolveReference: opción inexistente o texto sin dígitos = unmatched", () => {
    const items = [{ option: 1, id: "a" }];
    eq(m.resolveReference(items, "9").kind, "unmatched", "9");
    eq(m.resolveReference(items, "la de siempre").kind, "unmatched", "texto");
    eq(m.resolveReference([], "1").kind, "unmatched", "lista vacía");
  }],
  ["unmatchedAddressMessage lista las opciones con id", () => {
    const msg = m.unmatchedAddressMessage("9", [{ option: 1, address_id: "a1", address: "Calle 1, Cali" }]);
    assert(/1\) Calle 1, Cali \[address_id a1\]/.test(msg), msg);
    assert(/mismo turno/.test(msg), "pide reintentar en el mismo turno");
  }],

  // ---------------- saved_addresses (solo entrega)
  ["buildSavedAddresses: texto sin repetidas, option 1..n, sin used_for", () => {
    const r = m.buildSavedAddresses([
      { id: "a", line1: "Carrera 26 # 2i 24", line2: null, city: "Neiva" },
      { id: "b", line1: "carrera 26 # 2i 24, Neiva", line2: null, city: "Neiva" }, // misma
      { id: "c", line1: "Calle 5 # 3-2", line2: "Apto 4", city: "Cali" },
    ]);
    eq(r, [
      { option: 1, address_id: "a", address: "Carrera 26 # 2i 24, Neiva" },
      { option: 2, address_id: "c", address: "Calle 5 # 3-2 Apto 4, Cali" },
    ], "lista");
    assert(!("used_for" in r[0]), "sin flags de uso");
  }],
  ["buildSavedAddresses: omite relleno ('no registrada', 'pendiente', 'N/A') y topa en 3", () => {
    const rows = [
      { id: "x", line1: "Dirección no registrada", line2: null, city: "Cali" },
      { id: "y", line1: "pendiente", line2: null, city: null },
      ...[1, 2, 3, 4, 5].map((n) => ({ id: `r${n}`, line1: `Calle ${n} # 1-1`, line2: null, city: "Cali" })),
    ];
    const r = m.buildSavedAddresses(rows);
    eq(r.map((a: { address_id: string }) => a.address_id), ["r1", "r2", "r3"], "solo 3 reales");
  }],

  // ---------------- saved_profiles
  ["buildSavedProfiles: documento enmascarado, completo/incompleto, option, selected", () => {
    const rows = [completeProfile(), completeProfile({ id: "p2", label: "Empresa", document_type_code: "31", document_number: "900123456", legal_name: "ACME SAS", email: null, is_default: false })];
    const r = m.buildSavedProfiles(rows, "p2");
    eq(r.map((p: { option: number }) => p.option), [1, 2], "options");
    eq(r[0].document, "****050", "mask");
    eq(r[0].complete, true, "p1 completo");
    eq(r[1].complete, false, "p2 incompleto"); assert(r[1].missing.includes("correo de facturación"), "falta correo");
    eq([r[0].selected, r[1].selected], [false, true], "selected");
    eq(r[1].document_type, "NIT", "tipo");
    assert(!JSON.stringify(r).includes("1020304050") && !JSON.stringify(r).includes("900123456"), "documento completo nunca aparece");
  }],
  ["buildSavedProfiles: no repite el mismo documento+nombre y topa en 5", () => {
    const r = m.buildSavedProfiles([completeProfile(), completeProfile({ id: "p9" })]);
    eq(r.length, 1, "repetido");
    const many = m.buildSavedProfiles(Array.from({ length: 8 }, (_, i) => completeProfile({ id: `q${i}`, document_number: `10${i}0000${i}`, legal_name: `N${i}` })));
    eq(many.length, 5, "tope");
  }],
  ["maskDocument", () => {
    eq(m.maskDocument("1020304050"), "****050", "largo"); eq(m.maskDocument("1234"), "****", "corto"); eq(m.maskDocument(null), "sin documento", "null");
  }],

  // ---------------- validación de faltantes = la de buildFiscalBuyer
  ["profileMissing == buildFiscalBuyer.missing para perfiles variados", () => {
    const cases = [
      completeProfile(),
      completeProfile({ email: null }),
      completeProfile({ email: "no-es-correo" }),
      completeProfile({ legal_name: " " }),
      completeProfile({ document_type_code: "31", document_number: "900123456-9" }), // DV malo
      completeProfile({ address_line1: "Calle 1", country: "CO", city_code: null, state_code: null }),
      completeProfile({ document_type_code: null, document_number: null }),
    ];
    for (const p of cases) {
      const a = m.profileMissing(p);
      const b = buildFiscalBuyer({ client: { id: "c1", is_walk_in: false }, profile: p }).missing;
      eq(a, b, JSON.stringify(p));
      eq(a, billingProfileMissing(p).missing, "billingProfileMissing");
    }
    assert(m.profileMissing(completeProfile({ email: null })).includes("correo de facturación"), "correo obligatorio");
  }],
  ["profileMissing de un perfil NUEVO sin datos pide todo lo obligatorio", () => {
    const miss = m.profileMissing({});
    for (const f of ["nombre legal o razón social", "tipo de documento del cliente", "número de documento del cliente", "correo de facturación"]) assert(miss.includes(f), f);
  }],
  ["pickProfileFields: mapeo de tipo de documento, organización y correo en minúsculas; solo lo enviado", () => {
    const f = m.pickProfileFields({ document_type: "NIT", document_number: " 900123456-8 ", email: "A@X.CO", legal_name: "ACME" });
    eq(f.document_type_code, "31", "NIT"); eq(f.organization_type, "1", "jurídica");
    eq(f.document_number, "900123456-8", "trim"); eq(f.email, "a@x.co", "lower");
    assert(!("city" in f) && !("country" in f) && !("phone" in f), "no pisa lo no enviado");
    eq(m.pickProfileFields({ document_type: "CC" }).organization_type, "2", "natural");
    eq(m.pickProfileFields({ document_type: "13" }).document_type_code, "13", "código DIAN directo");
    let threw = false; try { m.pickProfileFields({ document_type: "LICENCIA" }); } catch { threw = true; } assert(threw, "tipo inválido falla");
  }],

  // ---------------- gate de confirm_quote
  ["gate: entrega sin dirección -> address_confirmation_required SOLO 'envío' (ya no 'facturación')", () => {
    const g = m.evaluateConfirmGate({ fulfillmentMethod: "delivery", shippingAddressId: null, invoiceRequested: false, billingProfileId: null, billingMissing: [] });
    eq(g, { reason: "address_confirmation_required", missing: ["envío"] }, "gate");
  }],
  ["gate: entrega con dirección y sin pedir factura -> libre (nada fiscal)", () => {
    eq(m.evaluateConfirmGate({ fulfillmentMethod: "delivery", shippingAddressId: "a", invoiceRequested: false, billingProfileId: null, billingMissing: ["correo de facturación"] }), null, "libre");
  }],
  ["gate: pickup y on_site no piden destino", () => {
    for (const f of ["pickup", "on_site"]) eq(m.evaluateConfirmGate({ fulfillmentMethod: f, shippingAddressId: null, invoiceRequested: false, billingProfileId: null, billingMissing: [] }), null, f);
  }],
  ["gate: método ausente se trata como entrega (default de la columna)", () => {
    eq(m.evaluateConfirmGate({ fulfillmentMethod: null, shippingAddressId: null, invoiceRequested: false, billingProfileId: null, billingMissing: [] })?.reason, "address_confirmation_required", "null");
  }],
  ["gate: pidió factura sin perfil -> billing_profile_required", () => {
    eq(m.evaluateConfirmGate({ fulfillmentMethod: "delivery", shippingAddressId: "a", invoiceRequested: true, billingProfileId: null, billingMissing: [] }), { reason: "billing_profile_required", missing: ["perfil de facturación"] }, "sin perfil");
    eq(m.evaluateConfirmGate({ fulfillmentMethod: "pickup", shippingAddressId: null, invoiceRequested: true, billingProfileId: null, billingMissing: [] })?.reason, "billing_profile_required", "pickup + factura");
  }],
  ["gate: pidió factura con perfil incompleto -> billing_profile_required con la lista; completo -> libre", () => {
    eq(m.evaluateConfirmGate({ fulfillmentMethod: "delivery", shippingAddressId: "a", invoiceRequested: true, billingProfileId: "p", billingMissing: ["correo de facturación"] }), { reason: "billing_profile_required", missing: ["correo de facturación"] }, "incompleto");
    eq(m.evaluateConfirmGate({ fulfillmentMethod: "delivery", shippingAddressId: "a", invoiceRequested: true, billingProfileId: "p", billingMissing: [] }), null, "completo");
  }],
  ["gate: la entrega se evalúa antes que la factura", () => {
    eq(m.evaluateConfirmGate({ fulfillmentMethod: "delivery", shippingAddressId: null, invoiceRequested: true, billingProfileId: null, billingMissing: [] })?.reason, "address_confirmation_required", "orden");
  }],
  ["gate integrado con el módulo de S2: dirección de relleno cuenta como sin destino; faltantes de factura = los de S2", () => {
    const ev = evaluateFulfillmentAndBilling({
      tenantId: "t1", contactId: "c1", fulfillmentMethod: "delivery",
      shippingAddressIdGiven: "a1", shippingAddress: { id: "a1", tenant_id: "t1", contact_id: "c1", line1: "Dirección no registrada" },
      billingProfileIdGiven: "p1", billingProfile: completeProfile({ email: null }), invoiceRequested: true, client: { id: "c1", is_walk_in: false },
    });
    const g = m.evaluateConfirmGate({ fulfillmentMethod: "delivery", shippingAddressId: ev.missingDestination.length ? null : "a1", invoiceRequested: true, billingProfileId: "p1", billingMissing: ev.missingBilling });
    eq(g?.reason, "address_confirmation_required", "relleno = sin destino");
    const ev2 = evaluateFulfillmentAndBilling({
      tenantId: "t1", contactId: "c1", fulfillmentMethod: "delivery",
      shippingAddressIdGiven: "a1", shippingAddress: { id: "a1", tenant_id: "t1", contact_id: "c1", line1: "Calle 1 # 2-3" },
      billingProfileIdGiven: "p1", billingProfile: completeProfile({ email: null }), invoiceRequested: true, client: { id: "c1", is_walk_in: false },
    });
    const g2 = m.evaluateConfirmGate({ fulfillmentMethod: "delivery", shippingAddressId: "a1", invoiceRequested: true, billingProfileId: "p1", billingMissing: ev2.missingBilling });
    eq(g2, { reason: "billing_profile_required", missing: ["correo de facturación"] }, "faltante de S2");
  }],

  // ---------------- DIVIPOLA
  ["resolveDivipola: inequívoco, sin tildes, 'Bogotá' vs 'Bogotá, D.C.'", () => {
    const cities = [{ code: "05001", name: "Medellín", department_code: "05" }, { code: "11001", name: "Bogotá, D.C.", department_code: "11" }];
    const depts = [{ code: "05", name: "Antioquia" }, { code: "11", name: "Bogotá, D.C." }];
    eq(m.resolveDivipola(cities, depts, "medellin"), { kind: "resolved", state_code: "05", city_code: "05001" }, "medellin");
    eq(m.resolveDivipola(cities, depts, "Bogota").kind, "resolved", "bogota");
    eq(m.resolveDivipola(cities, depts, "Atlantis").kind, "not_found", "no existe");
  }],
  ["resolveDivipola: nombre repetido exige departamento y nunca adivina", () => {
    const cities = [{ code: "15087", name: "Belén", department_code: "15" }, { code: "52083", name: "Belén", department_code: "52" }];
    const depts = [{ code: "15", name: "Boyacá" }, { code: "52", name: "Nariño" }];
    const amb = m.resolveDivipola(cities, depts, "Belén");
    eq(amb.kind, "ambiguous", "ambiguo"); eq(amb.options.sort(), ["Boyacá", "Nariño"], "opciones");
    eq(m.resolveDivipola(cities, depts, "Belén", "nariño"), { kind: "resolved", state_code: "52", city_code: "52083" }, "con depto");
    eq(m.resolveDivipola(cities, depts, "Belén", "Chocó").kind, "ambiguous", "depto que no ayuda sigue ambiguo");
  }],
  // ---------------- DIVIPOLA contra el catálogo REAL (migración 20260909240000)
  ["catálogo real: 1122 municipios y 33 departamentos cargados del archivo de migración", () => {
    eq(REAL_CITIES.length, 1122, "municipios"); eq(REAL_DEPTS.length, 33, "departamentos");
  }],
  ["catálogo real: los 1122 municipios con su nombre exacto + su departamento resuelven a sí mismos", () => {
    const bad: string[] = [];
    for (const c of REAL_CITIES) {
      const dept = REAL_DEPTS.find((d) => d.code === c.department_code)!.name;
      const r = m.resolveDivipola(REAL_CITIES, REAL_DEPTS, c.name, dept);
      if (r.kind !== "resolved" || r.city_code !== c.code || r.state_code !== c.department_code) bad.push(`${c.name}/${dept} -> ${JSON.stringify(r)}`);
    }
    assert(bad.length === 0, `${bad.length} fallos, p.ej. ${bad.slice(0, 3).join(" | ")}`);
  }],
  ["catálogo real: sin departamento, cada municipio se resuelve a sí mismo o devuelve la lista (con su departamento); nunca not_found ni otro municipio", () => {
    const bad: string[] = []; let resolved = 0, ambiguous = 0;
    for (const c of REAL_CITIES) {
      const dept = REAL_DEPTS.find((d) => d.code === c.department_code)!.name;
      const r = m.resolveDivipola(REAL_CITIES, REAL_DEPTS, c.name);
      if (r.kind === "resolved") { resolved++; if (r.city_code !== c.code) bad.push(`${c.name} -> ${r.city_code}`); }
      else if (r.kind === "ambiguous") { ambiguous++; if (!r.options.includes(dept)) bad.push(`${c.name}: opciones sin ${dept}`); }
      else bad.push(`${c.name} -> not_found`);
    }
    assert(bad.length === 0, `${bad.length} fallos, p.ej. ${bad.slice(0, 3).join(" | ")}`);
    assert(resolved > 900 && ambiguous > 0, `resolved=${resolved} ambiguous=${ambiguous}`);
  }],
  ["catálogo real: Cali, Cartagena, Cúcuta, Bogotá D.C. y Bogotá resuelven a la capital (aunque el catálogo diga otro nombre)", () => {
    const want: [string, string][] = [
      ["Cali", "76001"], ["cali", "76001"], ["Cartagena", "13001"], ["Cartagena de Indias", "13001"], ["Cúcuta", "54001"], ["Cucuta", "54001"],
      ["Bogotá D.C.", "11001"], ["Bogotá", "11001"], ["bogota d.c", "11001"], ["Bogotá, D.C.", "11001"],
      ["Neiva", "41001"], ["Medellin", "05001"], ["Barranquilla", "08001"], ["Bucaramanga", "68001"], ["Santa Marta", "47001"],
    ];
    for (const [name, code] of want) {
      const r = m.resolveDivipola(REAL_CITIES, REAL_DEPTS, name);
      assert(r.kind === "resolved" && r.city_code === code, `${name} -> ${JSON.stringify(r)}`);
    }
  }],
  ["catálogo real: 'Cali, Valle del Cauca' y 'Cali' + departamento 'Valle' resuelven; departamento equivocado no adivina un homónimo", () => {
    eq(m.resolveDivipola(REAL_CITIES, REAL_DEPTS, "Cali, Valle del Cauca").kind, "resolved", "coma");
    eq(m.resolveDivipola(REAL_CITIES, REAL_DEPTS, "Cali", "Valle").city_code, "76001", "valle");
    const r = m.resolveDivipola(REAL_CITIES, REAL_DEPTS, "Cartagena", "Caquetá");
    eq(r.city_code, "18150", "Cartagena del Chairá con Caquetá");
  }],
  ["catálogo real: nombres cortos/únicos (Une, Tena, Aipe, Ocaña, Oiba, Encino, Tona) y repetidos (Nariño, San José) se manejan sin truncar", () => {
    for (const n of ["Une", "Tena", "Aipe", "Ocaña", "Oiba", "Encino", "Tona", "Apía"]) {
      const r = m.resolveDivipola(REAL_CITIES, REAL_DEPTS, n);
      assert(r.kind === "resolved" || r.kind === "ambiguous", `${n} -> ${JSON.stringify(r)}`);
    }
    const nar = m.resolveDivipola(REAL_CITIES, REAL_DEPTS, "Nariño");
    eq(nar.kind, "ambiguous", "Nariño"); assert(nar.options.length >= 2, "lista de departamentos");
    const sj = m.resolveDivipola(REAL_CITIES, REAL_DEPTS, "San José");
    assert(sj.kind === "resolved" || sj.kind === "ambiguous", "San José");
    eq(m.resolveDivipola(REAL_CITIES, REAL_DEPTS, "Atlantis").kind, "not_found", "no existe");
    eq(m.resolveDivipola(REAL_CITIES, REAL_DEPTS, "   ").kind, "not_found", "vacío");
  }],
  ["catálogo real: resultado determinista aunque cambie el orden de las filas", () => {
    const shuffled = [...REAL_CITIES].reverse();
    for (const n of ["Cartagena", "Nariño", "Belén", "Cali", "San José", "Florencia"]) {
      eq(m.resolveDivipola(shuffled, REAL_DEPTS, n), m.resolveDivipola(REAL_CITIES, REAL_DEPTS, n), n);
    }
  }],
  ["redactBillingParameters: enmascara documento, teléfono, correo y calles solo en tools de facturación", () => {
    const r = m.redactBillingParameters("save_billing_profile", { tenant_id: "t", document_number: "1020304050", email: "ana@x.co", phone: "3001234567", address_line1: "Calle 1", legal_name: "Ana", city: "Cali" });
    eq(r.document_number, "****050", "doc"); eq(r.email, "a***@x.co", "mail"); eq(r.phone, "****567", "tel"); eq(r.address_line1, "[omitido]", "calle");
    eq(r.legal_name, "Ana", "conserva el resto"); eq(r.city, "Cali", "ciudad");
    const other = { document_number: "123456789", email: "a@b.co" };
    eq(m.redactBillingParameters("update_client_profile", other), other, "otras tools intactas");
    assert(!JSON.stringify(m.redactBillingParameters("save_billing_profile", { document_number: "1020304050", email: "ana@x.co" })).includes("1020304050"), "sin doc completo");
  }],
  ["toIsoCountry", () => {
    eq(m.toIsoCountry(""), "CO", "vacío"); eq(m.toIsoCountry("Colombia"), "CO", "nombre"); eq(m.toIsoCountry("us"), "US", "iso"); eq(m.toIsoCountry("Panamá"), null, "requiere catálogo");
  }],

  // ---------------- catálogo de tools / contratos
  ["tools de dirección: solo entrega (sin is_shipping/is_billing/tax_id/apply_as_billing), conserva apply_as_shipping y address_id", () => {
    const t = AI_TOOLS.find((x: { name: string }) => x.name === "save_contact_address");
    const props = Object.keys(t.parameters.properties);
    for (const gone of ["is_shipping", "is_billing", "tax_id", "apply_as_billing"]) assert(!props.includes(gone), gone);
    for (const kept of ["apply_as_shipping", "address_id", "order_number", "line1", "city"]) assert(props.includes(kept), kept);
    eq(t.skill, "clientes", "skill");
    assert(AI_TOOLS.some((x: { name: string }) => x.name === "list_contact_addresses"), "list_contact_addresses");
  }],
  ["tools de facturación nuevas: existen bajo 'ventas', sin parámetro de cliente (contactId lo inyecta el servidor)", () => {
    for (const name of ["list_billing_profiles", "select_billing_profile", "save_billing_profile"]) {
      const t = AI_TOOLS.find((x: { name: string }) => x.name === name);
      assert(t, name); eq(t.skill, "ventas", name + " skill");
      for (const k of Object.keys(t.parameters.properties)) assert(!/^(contact_id|client_id|tenant_id|conversation_id)$/.test(k), `${name}.${k}`);
    }
    eq(AI_TOOLS.find((x: { name: string }) => x.name === "list_billing_profiles").parameters.properties, {}, "list sin params");
    eq(AI_TOOLS.find((x: { name: string }) => x.name === "select_billing_profile").parameters.required, ["profile_id"], "select requiere profile_id");
    const save = AI_TOOLS.find((x: { name: string }) => x.name === "save_billing_profile").parameters.properties;
    for (const k of ["document_type", "document_number", "legal_name", "email", "fiscal_address_same_as_delivery", "apply_to_order", "profile_id"]) assert(k in save, k);
    assert(save.document_type.enum.includes("CC") && save.document_type.enum.includes("NIT"), "enum");
  }],
  ["isToolAllowed: defensa en profundidad por habilidad", () => {
    assert(isToolAllowed("select_billing_profile", new Set(["ventas"])), "con ventas");
    assert(!isToolAllowed("select_billing_profile", new Set(["clientes"])), "sin ventas");
    assert(!isToolAllowed("save_billing_profile", new Set()), "sin nada");
    assert(isToolAllowed("save_contact_address", new Set(["clientes"])), "direcciones con clientes");
    assert(toolsForSkills(new Set(["ventas"])).some((t: { name: string }) => t.name === "list_billing_profiles"), "ofrecida al modelo");
  }],
  ["confirm_quote declara wants_invoice (boolean) y no pide factura por defecto", () => {
    const t = AI_TOOLS.find((x: { name: string }) => x.name === "confirm_quote");
    eq(t.parameters.properties.wants_invoice.type, "boolean", "boolean"); eq(t.parameters.required, [], "required vacío");
    assert(/billing_profile_required/.test(t.description) && /address_confirmation_required/.test(t.description), "descripción documenta los dos gates");
    assert(!/apply_as_billing|is_billing/.test(t.description), "sin flags viejos");
  }],
  ["código (index.ts): sin billing_address_id/is_billing/apply_as_billing; gate usa evaluateConfirmGate; 23505 reutiliza", async () => {
    const src = await Deno.readTextFile(indexPath);
    assert(!/billing_address_id|apply_as_billing|billing_address_on_file|billing_address:/.test(src), "sin restos de dirección de facturación");
    assert(!/is_billing/.test(src), "sin is_billing");
    assert(/evaluateConfirmGate\(/.test(src), "gate compartido");
    assert(/billing_profile_required/.test(src) && /saved_profiles/.test(src), "resultado billing_profile_required");
    assert(/billing_profile_on_file/.test(src), "billing_profile_on_file");
    assert(/contact_addresses_unique_address_per_client/.test(src) && /findExistingAddressId/.test(src), "23505 reutiliza");
    assert(/resolveFulfillmentAndBilling\(/.test(src), "pertenencia con el módulo de S2");
    const i = src.indexOf('case "update_client_profile"'), j = src.indexOf('case "list_contact_addresses"');
    assert(i > 0 && j > i, "orden de case para do_not_contact.test.ts");
    // las tools de facturación nunca leen un id de cliente del modelo
    const k = src.indexOf('case "list_billing_profiles"'), l = src.indexOf('case "generate_payment_link"');
    const block = src.slice(k, l);
    assert(!/parameters\.(contact_id|client_id|tenant_id)/.test(block), "no lee id de cliente del modelo");
  }],
  ["código: domicilio fiscal no bloquea el perfil, catálogo completo sin limit, parámetros enmascarados, list con walk-in", async () => {
    const src = await Deno.readTextFile(indexPath);
    assert(!/cityLikePattern|from("cities")[^;]*\.limit\(/.test(src), "sin truncamiento de cities por limit");
    assert(/loadAllCities\(/.test(src) && /\.order\("code"\)\.range\(from, from \+ 999\)/.test(src), "catálogo completo paginado y ordenado");
    assert(/fiscal_address_saved/.test(src) && /for \(const k of ADDRESS_FIELDS\) delete fields\[k\]/.test(src), "descarta el domicilio sin bloquear");
    assert(/redactBillingParameters\(functionName, parameters\)/.test(src), "ai_tool_executions enmascarado");
    const k = src.indexOf('case "list_billing_profiles"');
    assert(/assertNotWalkIn/.test(src.slice(k, k + 300)), "list_billing_profiles rechaza walk-in");
    assert(/tax_regime_note/.test(src), "aviso de régimen en perfiles de empresa");
  }],
  ["sin gate de factura sin pedirla: el gate solo se evalúa con invoiceRequested", async () => {
    const src = await Deno.readTextFile(indexPath);
    assert(/const invoiceRequested = parameters\.wants_invoice === true \|\| !!order\.billing_profile_id;/.test(src), "invoiceRequested explícito");
  }],
];

let pass = 0, fail = 0;
for (const [name, fn] of tests) {
  try { await fn(); pass++; console.log("PASS " + name); } catch (e) { fail++; console.log("FAIL " + name + " :: " + (e as Error).message); }
}
console.log(`RESUMEN ${pass} PASS, ${fail} FAIL`);
Deno.exit(fail === 0 && pass > 0 ? 0 : 1);
