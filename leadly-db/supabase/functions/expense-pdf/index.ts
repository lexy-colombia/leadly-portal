/** Comprobante de egreso en PDF, devuelto en base64 -- la contraparte "de
 * archivo" de la tirilla térmica que imprime el frontend
 * (ExpenseReceiptTicket.tsx). Pedido explícito del usuario 2026-09-13:
 * "el imprimir que tenga el mismo concepto del pos o las ordenes, que me
 * genere la tirilla o el pdf con los datos".
 *
 * Misma forma que sales-invoice-pdf: solo lectura/render, cualquier miembro
 * del tenant puede verlo (mismo criterio que ver el gasto en pantalla), la
 * autorización es el select con el JWT del caller (la RLS de `expenses`
 * aísla por tenant) y el armado usa el admin client porque necesita leer
 * `tenants`, al que un agente no tiene por qué acceder directo. */
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { buildExpensePdf } from "../_shared/expenses/buildExpensePdf.ts";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "content-type": "application/json" } });
}

/** Nombre de una relación embebida de PostgREST, que puede venir como objeto
 * o como arreglo de un elemento según cómo infiera la cardinalidad. */
function embeddedName(value: unknown): string | null {
  const row = Array.isArray(value) ? value[0] : value;
  const name = (row as { name?: unknown } | null)?.name;
  return typeof name === "string" ? name : null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

  let body: { expense_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (!body.expense_id) return json({ error: "expense_id es requerido." }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });

  const {
    data: { user: caller },
    error: callerError,
  } = await callerClient.auth.getUser();
  if (callerError || !caller) return json({ error: "Invalid session" }, 401);

  // Este select con el JWT del caller ES la autorización -- si el gasto es de
  // otro tenant, la RLS lo devuelve null, igual que "no existe".
  const { data: expense } = await callerClient
    .from("expenses")
    .select("*, supplier:suppliers(name), category:expense_categories(name)")
    .eq("id", body.expense_id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!expense) return json({ error: "Gasto no encontrado." }, 404);

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  try {
    const [{ data: tenant }, { data: entries }] = await Promise.all([
      adminClient
        .from("tenants")
        .select("name, legal_name, document_type, document_number, billing_address, contact_email, contact_phone, country, state_province, logo_url")
        .eq("id", expense.tenant_id)
        .single(),
      adminClient
        .from("expense_inventory_entries")
        .select("quantity, unit_cost, subtotal, product:products(name)")
        .eq("expense_id", expense.id)
        .order("created_at", { ascending: true }),
    ]);
    if (!tenant) return json({ error: "No se pudo resolver el comercio." }, 500);

    // El logo es público (bucket tenant-logos) -- un fetch simple alcanza.
    // Si no hay logo, o la descarga falla, el PDF sale igual sin él: mismo
    // criterio que renderInvoicePdf.
    let logoBytes: Uint8Array | null = null;
    if (tenant.logo_url) {
      try {
        const logoRes = await fetch(tenant.logo_url);
        if (logoRes.ok) logoBytes = new Uint8Array(await logoRes.arrayBuffer());
      } catch {
        logoBytes = null;
      }
    }

    const bytes = await buildExpensePdf({
      tenant,
      logoBytes,
      expense: {
        number: expense.number,
        created_at: expense.created_at,
        amount: Number(expense.amount),
        currency: expense.currency,
        description: expense.description,
        payment_method: expense.payment_method,
        status: expense.status,
        expense_date: expense.expense_date,
        payment_date: expense.payment_date,
        supplier_name: embeddedName(expense.supplier),
        category_name: embeddedName(expense.category),
      },
      // PostgREST devuelve la relación embebida como objeto o como arreglo
      // según cómo infiera la cardinalidad -- se normalizan las dos formas
      // en vez de confiar en una sola.
      entries: (entries ?? []).map((e: Record<string, unknown>) => ({
        product_name: embeddedName(e.product) ?? "—",
        quantity: Number(e.quantity),
        unit_cost: Number(e.unit_cost),
        subtotal: Number(e.subtotal),
      })),
    });

    return json({ pdf_base64: bytesToBase64(bytes), filename: `EGR-${expense.number}.pdf` });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
