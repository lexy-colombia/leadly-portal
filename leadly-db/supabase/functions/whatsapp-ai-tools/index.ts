// The "executor service" for AI tool-calling -- deliberately separate from
// whatsapp-ai-respond (which only talks to the LLM), same split as
// tania-functions: one place that knows how to generate a response, another
// that knows how to actually act on the database, so the LLM-facing loop
// never has direct DB access itself.
// Internal-only: invoked by whatsapp-ai-respond using the service role key.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { json } from "../_shared/cors.ts";
import { AI_TOOLS, isToolAllowed } from "../_shared/aiTools.ts";
import { sendWhatsappImage } from "../_shared/whatsapp.ts";
import { chargeSalesOrderToCredit, createSalesOrderPaymentLink } from "../_shared/payments/salesOrderPayments.ts";
import { confirmSalesOrder, getStockTotals, getVariantStock, isPlaceholderAddressText } from "../_shared/orders/confirmSalesOrder.ts";
import { persistOrderItems, type ResolvedOrderItem } from "../_shared/orders/persistOrderItems.ts";
import { findStockShortfalls, type StockCheckItem } from "../_shared/orders/stockAvailability.ts";
import { makeIntegrationSecretGetter, resolveTenantIntegrationCredential } from "../_shared/integrations/credentials.ts";
import { createDeal, createOrUpdateContact, getDealPipelines } from "../_shared/integrations/hubspot.ts";
import { resolveShopifyDomain, searchCustomerByPhone, searchOrders, searchProducts } from "../_shared/integrations/shopify.ts";
import { combinePhone, splitPhone } from "../_shared/phone.ts";
import {
  bookAppointmentForContact,
  cancelActiveAppointmentForContact,
  findActiveUpcomingAppointment,
  listActiveUpcomingAppointmentsForContact,
} from "../_shared/appointments/manageAppointment.ts";

const CATALOG_SEARCH_LIMIT = 15;
/** Una cotización sin tocar en este tiempo deja de ser "el pedido en armado"
 * de la conversación -- ver resolveTargetOrder. */
const OPEN_QUOTE_MAX_AGE_HOURS = 12;
/** Dominio público del portal, donde vive la tienda (/tienda/:slug). El
 * backend no tenía ninguna referencia a él -- la tienda la arma el frontend.
 * Sobrescribible con el secreto PUBLIC_APP_URL. */
const PUBLIC_APP_URL = (Deno.env.get("PUBLIC_APP_URL") ?? "https://leadly.lexycolombia.com").replace(/\/+$/, "");
const CATEGORY_LIST_LIMIT = 5;
const CATEGORY_TOP_PRODUCTS_LIMIT = 5;

const OPPORTUNITY_PRIORITIES = ["baja", "media", "alta"];

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  if (!isServiceRoleCaller(authHeader)) {
    return json({ error: "Forbidden" }, 403);
  }

  let body: { function_name?: string; parameters?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const functionName = body.function_name;
  const parameters = body.parameters ?? {};
  if (!functionName) {
    return json({ error: "function_name is required" }, 400);
  }

  // tenant_id/conversation_id/contact_id are injected by whatsapp-ai-respond
  // (never taken from what the model itself claims) -- see _shared/aiTools.ts.
  const tenantId = parameters.tenant_id as string | undefined;
  const conversationId = parameters.conversation_id as string | undefined;
  const contactId = parameters.contact_id as string | undefined;
  if (!tenantId || !conversationId) {
    return json({ error: "tenant_id and conversation_id are required" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  let result: unknown = null;
  let errorMessage: string | null = null;
  try {
    if (!AI_TOOLS.some((tool) => tool.name === functionName)) {
      throw new Error(`Unknown function_name: ${functionName}`);
    }
    // Defense in depth: whatsapp-ai-respond only ever offers the model tools
    // from enabled skills, but this function is invoked purely by
    // function_name/parameters with no other trust signal -- re-check here
    // too, in case that ever drifts (a stale cached tool list, a bug), so a
    // disabled skill's tool can never actually execute even if requested.
    const enabledSkillKeys = await getEnabledSkillKeys(adminClient, conversationId);
    if (!isToolAllowed(functionName, enabledSkillKeys)) {
      throw new Error(`Tool ${functionName} is not enabled for this assistant`);
    }
    result = await executeTool(adminClient, functionName, tenantId, conversationId, contactId, parameters);
  } catch (err) {
    errorMessage = err instanceof Error ? err.message : "Unknown error executing tool";
  }

  await adminClient.from("ai_tool_executions").insert({
    tenant_id: tenantId,
    conversation_id: conversationId,
    function_name: functionName,
    parameters,
    result: errorMessage ? null : result,
    error_message: errorMessage,
  });

  if (errorMessage) return json({ error: errorMessage }, 200);
  return json({ result }, 200);
});

/** Same pattern as whatsapp-ai-respond's own copy -- compares the bearer
 * token directly against this function's SUPABASE_SERVICE_ROLE_KEY instead
 * of decoding it as a JWT (the newer sb_secret_... key format isn't one). */
function isServiceRoleCaller(authHeader: string): boolean {
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const expected = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  return !!expected && token === expected;
}

/** Resolves the conversation's whatsapp_line -> ai_assistant -> enabled
 * skill keys. Empty set (not an error) if anything along that chain is
 * missing -- executeTool's caller then rejects the tool call the same way
 * it would for a genuinely disabled skill. */
// deno-lint-ignore no-explicit-any
async function getEnabledSkillKeys(adminClient: any, conversationId: string): Promise<Set<string>> {
  const { data: conversation } = await adminClient
    .from("whatsapp_conversations")
    .select("whatsapp_line_id")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conversation) return new Set();

  const { data: line } = await adminClient
    .from("whatsapp_lines")
    .select("ai_assistant_id")
    .eq("id", conversation.whatsapp_line_id)
    .maybeSingle();
  if (!line?.ai_assistant_id) return new Set();

  const { data: assistant } = await adminClient
    .from("ai_assistants")
    .select("id")
    .eq("id", line.ai_assistant_id)
    .maybeSingle();
  if (!assistant) return new Set();

  const { data: rows } = await adminClient.from("ai_assistant_skills").select("skill_key").eq("ai_assistant_id", assistant.id);
  return new Set((rows ?? []).map((r: { skill_key: string }) => r.skill_key));
}

// deno-lint-ignore no-explicit-any
async function executeTool(
  adminClient: any,
  functionName: string,
  tenantId: string,
  conversationId: string,
  contactId: string | undefined,
  parameters: Record<string, unknown>,
): Promise<unknown> {
  // whatsapp-webhook stopped auto-creating a client on every inbound
  // message (2026-08-1x, to stop polluting the CRM with wrong numbers/
  // spam) -- a genuinely new customer now arrives here with contactId
  // still null. Resolve-or-create it lazily, right here, the first time
  // the model actually tries to *do* something for them (call any tool at
  // all) instead of on every inbound message -- explicit product decision
  // from the 2026-08-24 session, not a silent revert of the anti-pollution
  // change. No-op (single falsy check) once a contact is already linked.
  contactId = await resolveOrCreateContact(adminClient, tenantId, conversationId, contactId);

  switch (functionName) {
    case "book_appointment": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const scheduledAtRaw = String(parameters.scheduled_at ?? "").trim();
      if (!scheduledAtRaw) throw new Error("scheduled_at es requerido");
      const scheduledAt = new Date(scheduledAtRaw);
      if (isNaN(scheduledAt.getTime())) throw new Error("scheduled_at no es una fecha válida.");
      if (scheduledAt.getTime() < Date.now()) throw new Error("La fecha debe ser en el futuro.");
      const notes = parameters.notes ? String(parameters.notes).trim() : null;
      let durationMinutes: number | undefined;
      if (parameters.duration_minutes !== undefined && parameters.duration_minutes !== null) {
        const parsedDuration = Number(parameters.duration_minutes);
        if (!Number.isFinite(parsedDuration) || parsedDuration <= 0) throw new Error("duration_minutes debe ser un número positivo.");
        durationMinutes = Math.round(parsedDuration);
      }

      // Same line the conversation is already happening on -- no need to
      // look up "the contact's latest conversation" like the frontend drawer
      // does, we're already inside it.
      const { data: conversation } = await adminClient
        .from("whatsapp_conversations")
        .select("whatsapp_line_id")
        .eq("id", conversationId)
        .maybeSingle();

      // bookAppointmentForContact handles the idempotent "reschedule the
      // existing active appointment instead of creating a second one"
      // behavior server-side now (ver _shared/appointments/
      // manageAppointment.ts) -- same reasoning as before (bug found
      // 2026-08-14), and it also fixes a bug that reasoning introduced: the
      // reschedule branch now always recomputes ends_at instead of leaving
      // it stale (it used to rely on a trigger that only covers INSERT).
      const before = await findActiveUpcomingAppointment(adminClient, tenantId, contactId);
      const appointment = await bookAppointmentForContact(adminClient, {
        tenantId,
        contactId,
        whatsappLineId: conversation?.whatsapp_line_id ?? null,
        scheduledAt,
        durationMinutes,
        notes,
      });

      return { id: appointment.id, scheduled_at: appointment.scheduled_at, status: appointment.status, rescheduled: !!before };
    }

    case "list_contact_appointments": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const appointments = await listActiveUpcomingAppointmentsForContact(adminClient, tenantId, contactId);
      return { appointments };
    }

    case "cancel_appointment": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const appointment = await cancelActiveAppointmentForContact(adminClient, tenantId, contactId);
      return { id: appointment.id, status: appointment.status };
    }

    case "list_pipelines": {
      const { data, error } = await adminClient
        .from("pipelines")
        .select("name, description")
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);
      return { pipelines: data ?? [] };
    }

    case "create_opportunity": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const pipelineName = String(parameters.pipeline_name ?? "").trim();
      if (!pipelineName) throw new Error("pipeline_name es requerido");
      const title = String(parameters.title ?? "").trim();
      if (!title) throw new Error("title es requerido");
      const priority = parameters.priority ? String(parameters.priority) : "media";
      if (!OPPORTUNITY_PRIORITIES.includes(priority)) throw new Error(`priority inválida: ${priority}`);

      const { pipelineId, stageId } = await resolvePipelineAndFirstStage(adminClient, tenantId, pipelineName);

      // Idempotent by (contact, pipeline) instead of trusting the model to
      // remember "ya creé una para este cliente" across turns -- a stateless
      // per-turn LLM can't reliably track that itself (same reasoning as
      // resolveOrCreateOpportunityForQuote below). Reopening this tool call
      // on an existing open deal UPDATES it to the new call's title/value/
      // description instead of silently returning the stale one -- a
      // contact's open deal in a pipeline is treated as one rolling "what
      // they're currently interested in", not left describing whatever they
      // asked about first. Simpler than trying to detect "is this genuinely
      // a different product/deal" from free-text titles, and it's what
      // actually matched the real bug: a customer who asked about camisetas
      // earlier, then later asked about botas, kept showing "Interesado en
      // camisetas" in the pipeline forever.
      const { data: existing } = await adminClient
        .from("opportunities")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .eq("pipeline_id", pipelineId)
        .eq("status", "open")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing) {
        const { data: updated, error: updateError } = await adminClient
          .from("opportunities")
          .update({
            title,
            value: typeof parameters.value === "number" ? parameters.value : 0,
            priority,
            expected_close_date: parameters.expected_close_date ? String(parameters.expected_close_date) : null,
            description: parameters.description ? String(parameters.description).trim() : null,
          })
          .eq("id", existing.id)
          .select("id, title")
          .single();
        if (updateError) throw new Error(updateError.message);
        return updated;
      }

      const { data, error } = await adminClient
        .from("opportunities")
        .insert({
          tenant_id: tenantId,
          pipeline_id: pipelineId,
          stage_id: stageId,
          contact_id: contactId,
          title,
          value: typeof parameters.value === "number" ? parameters.value : 0,
          priority,
          expected_close_date: parameters.expected_close_date ? String(parameters.expected_close_date) : null,
          description: parameters.description ? String(parameters.description).trim() : null,
          source: "whatsapp_ia",
        })
        .select("id, title")
        .single();
      if (error) throw new Error(error.message);
      return data;
    }

    case "update_opportunity_stage": {
      const opportunity = await resolveLatestOpenOpportunity(adminClient, tenantId, contactId);
      const stageName = String(parameters.stage_name ?? "").trim();
      if (!stageName) throw new Error("stage_name es requerido");

      const { data: stages, error: stagesError } = await adminClient
        .from("pipeline_stages")
        .select("id, name, is_won, is_lost")
        .eq("pipeline_id", opportunity.pipeline_id);
      if (stagesError) throw new Error(stagesError.message);

      const stage = (stages ?? []).find((s: { name: string }) => s.name.toLowerCase() === stageName.toLowerCase());
      if (!stage) {
        const validNames = (stages ?? []).map((s: { name: string }) => s.name).join(", ");
        throw new Error(`Etapa "${stageName}" no existe en este pipeline. Etapas válidas: ${validNames}`);
      }

      const status = stage.is_won ? "won" : stage.is_lost ? "lost" : "open";
      const { error: updateError } = await adminClient.from("opportunities").update({ stage_id: stage.id, status }).eq("id", opportunity.id);
      if (updateError) throw new Error(updateError.message);
      return { id: opportunity.id, stage: stage.name, status };
    }

    case "get_opportunity_status": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data: opportunity, error } = await adminClient
        .from("opportunities")
        .select("id, title, value, currency, status, stage_id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!opportunity) return { found: false };

      const { data: stage } = await adminClient.from("pipeline_stages").select("name").eq("id", opportunity.stage_id).maybeSingle();
      return {
        found: true,
        title: opportunity.title,
        value: opportunity.value,
        currency: opportunity.currency,
        status: opportunity.status,
        stage: stage?.name ?? null,
      };
    }

    case "flag_interest_for_followup": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const productName = String(parameters.product_name ?? "").trim();
      if (!productName) throw new Error("product_name es requerido");
      const note = parameters.note ? String(parameters.note).trim() : null;

      const { data: opportunity } = await adminClient
        .from("opportunities")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .eq("status", "open")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: contact } = await adminClient.from("clients").select("assigned_to").eq("id", contactId).maybeSingle();

      const { error } = await adminClient.from("tasks").insert({
        tenant_id: tenantId,
        contact_id: contactId,
        opportunity_id: opportunity?.id ?? null,
        assigned_to: contact?.assigned_to ?? null,
        title: `Seguimiento: interés en ${productName}`,
        description: note,
        priority: "media",
        due_date: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      });
      if (error) throw new Error(error.message);

      return { flagged: true, product: productName };
    }

    case "list_catalog_categories": {
      // Hard-capped at CATEGORY_LIST_LIMIT server-side (not left to the
      // model to "remember to only show 5") -- a tenant that wants its
      // greeting to lead with categories needs this to be reliable, not a
      // prompt suggestion the model might ignore on a long category list.
      const { data, error } = await adminClient
        .from("product_categories")
        .select("name, description")
        .eq("tenant_id", tenantId)
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .limit(CATEGORY_LIST_LIMIT);
      if (error) throw new Error(error.message);
      // storefront_url en la respuesta de la herramienta, no solo escrito en
      // el prompt (2026-09-14): con el enlace únicamente en el system_prompt,
      // el modelo contestó "me das el catálogo" / "qué tienen" con la lista de
      // categorías y nunca lo compartió, dos veces seguidas. Solo viene si el
      // tenant tiene la tienda pública activa. whatsapp-ai-respond además lo
      // agrega al final si el modelo lo omite (ensureStorefrontLink).
      const storefrontUrl = await getStorefrontUrl(adminClient, tenantId);
      return { categories: data ?? [], ...(storefrontUrl ? { storefront_url: storefrontUrl } : {}) };
    }

    case "list_catalog_products": {
      // Devuelve `in_stock` (sí/no) por producto, nunca la cantidad.
      // Cambio de criterio 2026-09-14, pedido explícito del usuario tras una
      // prueba real: antes esto no exponía stock en absoluto y la falta de
      // stock se descubría recién al confirmar, después de que el cliente
      // ya había dado nombre, documento y dirección. El agotado tiene que
      // salir en la consulta. La cantidad exacta sigue sin exponerse acá --
      // solo aparece en create_quote cuando piden más de lo que hay.
      // ⚠️ Acoplado con el fragmento global de `catalogo` (migración
      // 20260914150000): si este campo cambia, ese fragmento también.
      const search = parameters.search ? String(parameters.search).trim() : "";
      const category = parameters.category ? String(parameters.category).trim() : "";
      const brand = parameters.brand ? String(parameters.brand).trim() : "";

      // A product can be in several categories now (product_category_links,
      // 2026-08-17) -- there's no direct products.category_id FK anymore for
      // PostgREST to embed-and-filter on in one query, so a category filter
      // resolves to a set of product ids first (via the link table), then
      // scopes the actual products query with .in(). categorySelect always
      // embeds every one of a product's categories (categories:string[] in
      // the response), not just whichever one matched the filter.
      const categorySelect =
        "id, name, slug, sku, retail_price, description, track_inventory, is_visible_in_catalog, categories:product_category_links(category:product_categories(name))";

      async function productIdsForCategory(categoryName: string): Promise<string[] | null> {
        const { data: categoryRow, error: categoryError } = await adminClient
          .from("product_categories")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("name", categoryName)
          .maybeSingle();
        if (categoryError) throw new Error(categoryError.message);
        if (!categoryRow) return null; // no such category -- caller returns an empty result, not every product

        const { data: links, error: linksError } = await adminClient
          .from("product_category_links")
          .select("product_id")
          .eq("tenant_id", tenantId)
          .eq("category_id", categoryRow.id);
        if (linksError) throw new Error(linksError.message);
        return (links ?? []).map((l: { product_id: string }) => l.product_id);
      }

      // Unlike category, products.brand_id is a direct FK -- no join table,
      // so this only needs to resolve the brand's id, callers filter with
      // .eq("brand_id", ...) directly instead of an .in() over a set.
      async function brandIdByName(brandName: string): Promise<string | null> {
        const { data: brandRow, error: brandError } = await adminClient
          .from("brands")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("name", brandName)
          .maybeSingle();
        if (brandError) throw new Error(brandError.message);
        return brandRow?.id ?? null;
      }

      function mapProduct(p: any, stockTotals: Map<string, { available: number }>, storefrontUrl: string | null) {
        const productUrl = buildProductUrl(storefrontUrl, p);
        return {
          name: p.name,
          sku: p.sku,
          price: formatCurrencyCOP(p.retail_price),
          categories: (p.categories ?? []).map((c: any) => c.category?.name).filter(Boolean),
          description: p.description ?? null,
          in_stock: !p.track_inventory || (stockTotals.get(p.id)?.available ?? 0) > 0,
          // Enlace del producto en la tienda pública (2026-09-14), solo si
          // está publicado -- ver buildProductUrl.
          ...(productUrl ? { product_url: productUrl } : {}),
        };
      }

      // Category/brand browsing (no search term) is a distinct case: pulls
      // stock internally to rank by it (most-stocked first -- a reasonable
      // proxy for "what to lead with" when a tenant wants a proactive
      // salesperson tone), then strips it back out of what actually gets
      // returned. The model never sees the numbers, only the resulting order.
      if ((category || brand) && !search) {
        const productIds = category ? await productIdsForCategory(category) : null;
        if (category && (!productIds || productIds.length === 0)) return { products: [] };
        const brandId = brand ? await brandIdByName(brand) : null;
        if (brand && !brandId) return { products: [] };

        let browseQuery = adminClient
          .from("products")
          .select(categorySelect)
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .is("deleted_at", null);
        if (productIds) browseQuery = browseQuery.in("id", productIds);
        if (brandId) browseQuery = browseQuery.eq("brand_id", brandId);
        const { data, error } = await browseQuery;
        if (error) throw new Error(error.message);

        // products carries no stock counter of its own (see
        // types/domain.ts) -- available-per-product lives in product_stock,
        // summed across warehouses, same aggregation listStockTotalsByTenant
        // does client-side in leadly-app.
        const stockTotals = await getStockTotals(adminClient, tenantId, (data ?? []).map((p: any) => p.id));
        const browseStorefrontUrl = await getStorefrontUrl(adminClient, tenantId);

        const ranked = (data ?? [])
          .map((p: any) => ({
            ...mapProduct(p, stockTotals, browseStorefrontUrl),
            _rank: p.track_inventory ? (stockTotals.get(p.id)?.available ?? 0) : Number.POSITIVE_INFINITY,
          }))
          .sort((a: any, b: any) => b._rank - a._rank)
          .slice(0, CATEGORY_TOP_PRODUCTS_LIMIT)
          .map(({ _rank, ...rest }: any) => rest);

        return { products: ranked, ...(browseStorefrontUrl ? { storefront_url: browseStorefrontUrl } : {}) };
      }

      const categoryProductIds = category ? await productIdsForCategory(category) : null;
      if (category && (!categoryProductIds || categoryProductIds.length === 0)) return { products: [] };
      const searchBrandId = brand ? await brandIdByName(brand) : null;
      if (brand && !searchBrandId) return { products: [] };

      let query = adminClient
        .from("products")
        .select(categorySelect)
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("name", { ascending: true })
        .limit(CATALOG_SEARCH_LIMIT);
      if (categoryProductIds) query = query.in("id", categoryProductIds);
      if (searchBrandId) query = query.eq("brand_id", searchBrandId);

      // Full-text search (Spanish config), not a rigid ILIKE substring --
      // an ILIKE '%camiseta de algodón%' never matches "Camiseta Algodón
      // Premium" (word order/extra words), and '%camisetas%' never matches
      // singular "Camiseta" either. to_tsvector/plainto_tsquery handles
      // plurals, word order and accents correctly instead.
      if (search) query = query.textSearch("name", search, { type: "plain", config: "spanish" });

      let { data, error } = await query;
      if (error) throw new Error(error.message);
      // Fallback for queries textSearch can legitimately miss (a bare SKU,
      // a single short word) -- only runs when the primary search found
      // nothing, so it never changes behavior for a query that already works.
      if (search && (!data || data.length === 0)) {
        let fallbackQuery = adminClient
          .from("products")
          .select(categorySelect)
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .is("deleted_at", null)
          .ilike("name", `%${search}%`)
          .order("name", { ascending: true })
          .limit(CATALOG_SEARCH_LIMIT);
        if (categoryProductIds) fallbackQuery = fallbackQuery.in("id", categoryProductIds);
        if (searchBrandId) fallbackQuery = fallbackQuery.eq("brand_id", searchBrandId);
        const fallback = await fallbackQuery;
        if (fallback.error) throw new Error(fallback.error.message);
        data = fallback.data;
      }

      const searchStockTotals = await getStockTotals(adminClient, tenantId, (data ?? []).map((p: any) => p.id));
      const searchBaseUrl = await getStorefrontUrl(adminClient, tenantId);
      const products = (data ?? []).map((p: any) => mapProduct(p, searchStockTotals, searchBaseUrl));

      // Auto-attach the photo when `search` pins down exactly one product --
      // see trySendSingleProductImage's comment for why this isn't left to
      // the model remembering to also call send_product_image afterward.
      const isSingleSearchResult = !!search && (data?.length ?? 0) === 1;
      const imageSent = isSingleSearchResult ? await trySendSingleProductImage(adminClient, conversationId, (data as { id: string }[])[0].id) : null;

      // Con varios resultados (o ninguno) la tienda ayuda a elegir; con uno
      // solo ya va la foto con su ficha y el enlace sobra.
      const searchStorefrontUrl = isSingleSearchResult ? null : searchBaseUrl;
      return {
        products,
        ...(isSingleSearchResult ? { image_sent: imageSent } : {}),
        ...(searchStorefrontUrl ? { storefront_url: searchStorefrontUrl } : {}),
      };
    }

    case "send_product_image": {
      const productName = String(parameters.product_name ?? "").trim();
      if (!productName) throw new Error("product_name es requerido");

      const product = await findProductByName(adminClient, tenantId, productName);
      if (!product) throw new Error(`No se encontró el producto "${productName}" en el catálogo.`);

      const { data: image, error: imageError } = await adminClient
        .from("product_images")
        .select("storage_path")
        .eq("product_id", product.id)
        .order("display_order", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (imageError) throw new Error(imageError.message);
      if (!image) throw new Error(`El producto "${product.name}" todavía no tiene ninguna foto cargada.`);

      // product-images is a public bucket (unlike crm-attachments) -- no
      // signed URL needed, Meta can fetch the public URL directly.
      const { data: publicUrlData } = adminClient.storage.from("product-images").getPublicUrl(image.storage_path);

      const sendContext = await resolveConversationSendContext(adminClient, conversationId);
      // Misma ficha en el caption que el envío automático -- ver
      // buildProductImageCaption.
      const caption = await buildProductImageCaption(adminClient, String(product.id));
      const sendResult = await sendWhatsappImage(sendContext.phoneNumberId, sendContext.accessToken, sendContext.contactPhone, publicUrlData.publicUrl, caption);
      if (!sendResult.ok) throw new Error(sendResult.errorMessage ?? "No se pudo enviar la imagen.");

      await adminClient.from("whatsapp_messages").insert({
        conversation_id: conversationId,
        direction: "outbound",
        sender_type: "ia",
        content: "[Imagen enviada]",
        wamid: sendResult.wamid,
      });

      return { sent: true, product: product.name };
    }

    case "list_product_variants": {
      const productName = String(parameters.product_name ?? "").trim();
      if (!productName) throw new Error("product_name es requerido");

      const product = await findProductByName(adminClient, tenantId, productName);
      if (!product) throw new Error(`No se encontró el producto "${productName}" en el catálogo.`);
      // `in_stock` por variante (o por producto, si no tiene variantes) --
      // ver el comentario de list_catalog_products.
      const productUrl = buildProductUrl(await getStorefrontUrl(adminClient, tenantId), product);
      const productUrlField = productUrl ? { product_url: productUrl } : {};
      const tracksInventory = !!product.track_inventory;
      if (!product.has_variants) {
        const totals = tracksInventory ? await getStockTotals(adminClient, tenantId, [String(product.id)]) : null;
        return { has_variants: false, in_stock: !totals || (totals.get(String(product.id))?.available ?? 0) > 0, ...productUrlField };
      }

      const { data, error } = await adminClient
        .from("product_variants")
        .select("id, sku, retail_price, option1_value, option2_value, option3_value")
        .eq("tenant_id", tenantId)
        .eq("product_id", product.id)
        .eq("is_active", true)
        .is("deleted_at", null);
      if (error) throw new Error(error.message);

      const variantStock = tracksInventory ? await getStockByVariant(adminClient, tenantId, String(product.id)) : null;

      const variants = (data ?? []).map((v: { id: string; sku: string; retail_price: number; option1_value: string | null; option2_value: string | null; option3_value: string | null }) => ({
        label: [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(" / "),
        sku: v.sku,
        price: formatCurrencyCOP(v.retail_price),
        in_stock: !variantStock || (variantStock.get(v.id) ?? 0) > 0,
      }));

      return { has_variants: true, variants, ...productUrlField };
    }

    case "create_quote": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const rawItems = Array.isArray(parameters.items) ? parameters.items : [];
      if (rawItems.length === 0) throw new Error("items es requerido y no puede estar vacío.");

      const resolvedItems: {
        product_id: string;
        variant_id: string | null;
        product_name: string;
        sku: string | null;
        quantity: number;
        unit_price: number;
        tax_type_code: string | null;
        tax_rate: number;
      }[] = [];
      const stockItems: StockCheckItem[] = [];
      for (const rawItem of rawItems) {
        const productName = String((rawItem as Record<string, unknown>).product_name ?? "").trim();
        const variantLabel = String((rawItem as Record<string, unknown>).variant ?? "").trim();
        const quantity = Number((rawItem as Record<string, unknown>).quantity);
        if (!productName) throw new Error("Cada línea necesita product_name.");
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Cantidad inválida para "${productName}".`);

        const product = await findProductByName(adminClient, tenantId, productName);
        if (!product) throw new Error(`No se encontró el producto "${productName}" en el catálogo.`);

        // Un producto con variantes no tiene precio/stock propio -- vender
        // "el producto" sin elegir una variante dejaría la venta sin saber
        // qué color/talla se descuenta del stock real (ver 2026-08-24).
        // Obliga a consultar list_product_variants primero, mismo criterio
        // que "nunca inventes un producto que list_catalog_products no
        // devolvió".
        let variantId: string | null = null;
        let unitPrice = (product.retail_price as number) ?? 0;
        let sku = product.sku as string | null;
        if (product.has_variants) {
          if (!variantLabel) {
            const labels = await listVariantLabels(adminClient, tenantId, product.id as string);
            throw new Error(
              `"${productName}" tiene variantes: ${labels.join(", ")}. Si el cliente ya te dijo cuál quiere, incluí "variant" con ese valor exacto en tu próxima llamada -- volver a llamar sin "variant" va a fallar otra vez, exactamente igual. Si todavía no te lo dijo, preguntaselo primero.`,
            );
          }
          const variant = await findVariantByLabel(adminClient, tenantId, product.id as string, variantLabel);
          if (!variant) throw new Error(`No se encontró la variante "${variantLabel}" para "${productName}". Consultá list_product_variants para ver las opciones reales.`);
          variantId = variant.id as string;
          unitPrice = (variant.retail_price as number) ?? unitPrice;
          sku = variant.sku as string;
        }

        // Stock: se revisa abajo, antes de crear el pedido
        // (assertStockForQuote). El 2026-08-10 se había sacado de acá para
        // que un faltante no impidiera crear la oportunidad; volvió el
        // 2026-09-14, pedido explícito del usuario tras una prueba real en
        // la que el cliente dio todos sus datos y recién al final se enteró
        // de que "no había". La oportunidad la registra create_opportunity
        // desde el primer interés, no depende de que el pedido se arme.
        stockItems.push({
          product_id: product.id as string,
          variant_id: variantId,
          product_name: variantId ? `${product.name} (${variantLabel})` : (product.name as string),
          quantity,
        });
        resolvedItems.push({
          product_id: product.id as string,
          variant_id: variantId,
          product_name: product.name as string,
          sku,
          quantity,
          unit_price: unitPrice,
          // El impuesto es una clasificación del producto, nunca de la
          // variante (ver 20260903100500_products_tax_fields.sql) -- una
          // variante nunca trae su propio tax_type_code/tax_rate.
          tax_type_code: (product.tax_type_code as string | null) ?? null,
          tax_rate: (product.tax_rate as number) ?? 0,
        });
      }

      await assertStockForQuote(adminClient, tenantId, stockItems);

      // Estimado solo para resolveOrCreateOpportunityForQuote (antes de
      // tener un order.id) -- el subtotal/tax_total/total reales los
      // calcula persistOrderItems más abajo, única fuente de verdad
      // compartida con add_item_to_quote/storefront/el portal.
      const roughSubtotal = resolvedItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      const notes = parameters.notes ? String(parameters.notes).trim() : null;

      // Auto-links to the pipeline so a WhatsApp sale shows up there without
      // anyone loading it by hand: reuse the contact's open opportunity if
      // it has one, otherwise create one (see resolveOrCreateOpportunityForQuote).
      const opportunityId = await resolveOrCreateOpportunityForQuote(adminClient, tenantId, contactId, roughSubtotal);

      const { data: order, error: orderError } = await adminClient
        .from("sales_orders")
        .insert({ tenant_id: tenantId, contact_id: contactId, opportunity_id: opportunityId, notes, subtotal: 0, tax_total: 0, total: 0, sales_channel: "whatsapp" })
        .select("id, number")
        .single();
      if (orderError) throw new Error(orderError.message);

      const totals = await persistOrderItems(adminClient, tenantId, order.id, resolvedItems, 0);

      const subtotal = totals.subtotal;

      return {
        order_number: order.number,
        order_code: formatOrderCode(order.number),
        status_label: statusLabel("cotizacion"),
        total: formatCurrencyCOP(subtotal),
        items: resolvedItems.map((i) => ({
          product: i.product_name,
          quantity: i.quantity,
          unit_price: formatCurrencyCOP(i.unit_price),
          subtotal: formatCurrencyCOP(i.quantity * i.unit_price),
        })),
        // Direcciones guardadas en texto: el modelo se las lista al cliente
        // y le pregunta cuál usar antes de confirm_quote (2026-09-14).
        saved_addresses: await listAddressesForConversation(adminClient, tenantId, contactId),
      };
    }

    case "add_item_to_quote": {
      const orderNumber = parseOrderNumber(parameters.order_number);
      const { order, latest } = await resolveTargetOrder(adminClient, tenantId, contactId, orderNumber);
      if (!order) throw orderNotOpenError(latest, orderNumber, "modificar");

      const rawItems = Array.isArray(parameters.items) ? parameters.items : [];
      if (rawItems.length === 0) throw new Error("items es requerido y no puede estar vacío.");

      // persistOrderItems reemplaza TODOS los ítems del pedido -- hay que
      // traer los que ya existen (tal cual quedaron, sin recalcularlos
      // contra el precio/impuesto actual del producto, que pudo cambiar
      // desde que se agregaron) y sumarles los nuevos antes de llamarla.
      const { data: existingItems, error: existingItemsError } = await adminClient
        .from("sales_order_items")
        .select("product_id, variant_id, warehouse_id, product_name, sku, quantity, unit_price, discount_amount, tax_type_code, tax_rate")
        .eq("order_id", order.id)
        .order("display_order", { ascending: true });
      if (existingItemsError) throw new Error(existingItemsError.message);

      const items: ResolvedOrderItem[] = [...(existingItems ?? [])];

      // Same product/variant resolution as create_quote -- no stock check, a
      // cotización is still just a price estimate at this point.
      for (const rawItem of rawItems) {
        const productName = String((rawItem as Record<string, unknown>).product_name ?? "").trim();
        const variantLabel = String((rawItem as Record<string, unknown>).variant ?? "").trim();
        const quantity = Number((rawItem as Record<string, unknown>).quantity);
        if (!productName) throw new Error("Cada línea necesita product_name.");
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Cantidad inválida para "${productName}".`);

        const product = await findProductByName(adminClient, tenantId, productName);
        if (!product) throw new Error(`No se encontró el producto "${productName}" en el catálogo.`);

        let variantId: string | null = null;
        let unitPrice = (product.retail_price as number) ?? 0;
        let sku = product.sku as string | null;
        if (product.has_variants) {
          if (!variantLabel) {
            const labels = await listVariantLabels(adminClient, tenantId, product.id as string);
            throw new Error(
              `"${productName}" tiene variantes: ${labels.join(", ")}. Si el cliente ya te dijo cuál quiere, incluí "variant" con ese valor exacto en tu próxima llamada -- volver a llamar sin "variant" va a fallar otra vez, exactamente igual. Si todavía no te lo dijo, preguntaselo primero.`,
            );
          }
          const variant = await findVariantByLabel(adminClient, tenantId, product.id as string, variantLabel);
          if (!variant) throw new Error(`No se encontró la variante "${variantLabel}" para "${productName}". Consultá list_product_variants para ver las opciones reales.`);
          variantId = variant.id as string;
          unitPrice = (variant.retail_price as number) ?? unitPrice;
          sku = variant.sku as string;
        }

        items.push({
          product_id: product.id as string,
          variant_id: variantId,
          product_name: product.name as string,
          sku,
          quantity,
          unit_price: unitPrice,
          tax_type_code: (product.tax_type_code as string | null) ?? null,
          tax_rate: (product.tax_rate as number) ?? 0,
        });
      }

      // Mismo chequeo de stock que create_quote, sobre el pedido completo
      // (lo que ya tenía + lo nuevo), antes de escribir nada.
      await assertStockForQuote(
        adminClient,
        tenantId,
        items.map((item) => ({ product_id: item.product_id, variant_id: item.variant_id, product_name: item.product_name, quantity: item.quantity })),
      );

      // Sin envío en este flujo -- ver comentario histórico más arriba, la
      // IA nunca setea shipping en una cotización.
      const totals = await persistOrderItems(adminClient, tenantId, order.id, items, 0);

      const { data: allItems, error: allItemsError } = await adminClient
        .from("sales_order_items")
        .select("product_name, quantity, unit_price, subtotal")
        .eq("order_id", order.id)
        .order("display_order", { ascending: true });
      if (allItemsError) throw new Error(allItemsError.message);

      return {
        order_number: order.number,
        order_code: formatOrderCode(order.number),
        status_label: statusLabel("cotizacion"),
        total: formatCurrencyCOP(totals.total),
        items: (allItems ?? []).map((item: { product_name: string; quantity: number; unit_price: number; subtotal: number }) => ({
          product: item.product_name,
          quantity: item.quantity,
          unit_price: formatCurrencyCOP(item.unit_price),
          subtotal: formatCurrencyCOP(item.subtotal),
        })),
      };
    }

    case "get_quote_status": {
      // Con `order_number` consulta ese pedido puntual (el cliente lo nombró);
      // `can_modify` le dice al modelo si todavía se puede cambiar.
      const orderNumber = parseOrderNumber(parameters.order_number);
      const order = await resolveLatestOrder(adminClient, tenantId, contactId, undefined, orderNumber ?? undefined);
      if (!order) return { found: false };

      const { data: items } = await adminClient
        .from("sales_order_items")
        .select("product_name, quantity, unit_price, subtotal")
        .eq("order_id", order.id)
        .order("display_order", { ascending: true });

      const { data: payments } = await adminClient.from("sales_order_payments").select("amount").eq("order_id", order.id).is("deleted_at", null);
      const totalPaid = (payments ?? []).reduce((sum: number, p: { amount: number }) => sum + p.amount, 0);
      const balanceDue = Math.max(0, order.total - totalPaid);

      return {
        found: true,
        order_number: order.number,
        order_code: formatOrderCode(order.number),
        status: order.status,
        status_label: statusLabel(order.status),
        total: formatCurrencyCOP(order.total),
        total_paid: formatCurrencyCOP(totalPaid),
        balance_due: formatCurrencyCOP(balanceDue),
        notes: order.notes,
        can_modify: order.status === "cotizacion",
        items: (items ?? []).map((item: { product_name: string; quantity: number; unit_price: number; subtotal: number }) => ({
          product_name: item.product_name,
          quantity: item.quantity,
          unit_price: formatCurrencyCOP(item.unit_price),
          subtotal: formatCurrencyCOP(item.subtotal),
        })),
      };
    }

    case "add_order_comment": {
      const order = await resolveLatestOrder(adminClient, tenantId, contactId);
      if (!order) throw new Error("Este cliente no tiene ninguna cotización ni venta todavía.");
      const comment = String(parameters.comment ?? "").trim();
      if (!comment) throw new Error("comment es requerido");

      const { error } = await adminClient
        .from("sales_order_comments")
        .insert({ tenant_id: tenantId, order_id: order.id, content: comment, created_by_ai: true });
      if (error) throw new Error(error.message);

      return { order_number: order.number, order_code: formatOrderCode(order.number), commented: true };
    }

    case "confirm_quote": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const orderNumber = parseOrderNumber(parameters.order_number);
      const { order, latest } = await resolveTargetOrder(adminClient, tenantId, contactId, orderNumber);
      if (!order) {
        // Encontrado en vivo 2026-09-13: con payment_options en la mano, el
        // modelo volvió a llamar confirm_quote en vez de la herramienta de
        // pago. Decirle exactamente qué corresponde corta ese loop.
        if (orderNumber === null && latest?.status === "confirmada" && isRecentlyTouched(latest)) {
          throw new Error(
            `El pedido ${formatOrderCode(latest.number)} ya está confirmado -- no vuelvas a llamar confirm_quote. Si el cliente está eligiendo cómo pagar, usa charge_sale_to_credit o generate_payment_link.`,
          );
        }
        throw orderNotOpenError(latest, orderNumber, "confirmar");
      }

      // Direcciones confirmadas con el cliente, nunca asignadas solas
      // (pedido explícito del usuario 2026-09-14): el modelo le lista las
      // guardadas, le pregunta si envía a esa y si factura con los mismos
      // datos, y las aplica con save_contact_address. Mientras el pedido no
      // tenga las dos aplicadas, no se confirma -- sin esto, el trigger de
      // confirmación elegiría en silencio la dirección por defecto, que
      // puede no ser la que el cliente quiere.
      if (!order.shipping_address_id || !order.billing_address_id) {
        return {
          order_number: order.number,
          order_code: formatOrderCode(order.number),
          blocked: true,
          reason: "address_confirmation_required",
          missing: [order.shipping_address_id ? null : "envío", order.billing_address_id ? null : "facturación"].filter(Boolean),
          saved_addresses: await listAddressesForConversation(adminClient, tenantId, contactId),
        };
      }
      const shippingAddressId = order.shipping_address_id;
      const billingAddressId = order.billing_address_id;

      // Stock check, address gate, opportunity move, and invoice queueing
      // all live in DB triggers now (guard_sales_order_confirmation /
      // apply_sales_order_confirmed_effects, 20260903180000) -- they apply
      // to ANY update that sets status='confirmada', not just this path, so
      // the portal's own manual "Confirmar" button gets the exact same
      // rules for free. confirmSalesOrder here just does the status flip
      // and translates a trigger rejection back into a typed `blocked`
      // result for the conversation.
      const result = await confirmSalesOrder(adminClient, tenantId, contactId, order.id);
      if (result.blocked) {
        return {
          order_number: order.number,
          order_code: formatOrderCode(order.number),
          blocked: true,
          reason: result.reason,
          ...(result.detail ? { detail: result.detail.replace(/^INSUFFICIENT_STOCK:\s*/, "") } : {}),
        };
      }

      // Resuelve el pago acá mismo, en la misma llamada, en vez de dejarlo
      // como una segunda decisión aparte del modelo. Encontrado en vivo
      // 2026-08-25: aun con una instrucción explícita en el prompt de
      // resolver el pago "en el mismo turno", el modelo confirmó la venta y
      // pasó directo a responderle al cliente sin generar el link -- recién
      // lo generó un turno completo después, cuando el cliente tuvo que
      // preguntar. Mismo criterio que ya usamos con las fotos de producto:
      // si la acción es automática y no depende de que el cliente elija
      // entre opciones, no tiene sentido dejarla en manos de que el modelo
      // se acuerde de llamar una segunda tool.
      const paymentInfo = await resolvePaymentAfterConfirm(adminClient, tenantId, conversationId, contactId, result.order.id);

      const [shippingAddress, billingAddress] = await Promise.all([describeAddress(adminClient, shippingAddressId), describeAddress(adminClient, billingAddressId)]);

      return {
        order_number: result.order.number,
        order_code: formatOrderCode(result.order.number),
        status: "confirmada",
        status_label: statusLabel("confirmada"),
        ...(shippingAddress ? { shipping_address: shippingAddress } : {}),
        ...(billingAddress ? { billing_address: billingAddress } : {}),
        ...paymentInfo,
      };
    }

    case "cancel_quote": {
      const orderNumber = parseOrderNumber(parameters.order_number);
      const { order, latest } = await resolveTargetOrder(adminClient, tenantId, contactId, orderNumber);
      if (!order) throw orderNotOpenError(latest, orderNumber, "anular");

      const { error } = await adminClient.from("sales_orders").update({ status: "cancelada" }).eq("id", order.id);
      if (error) throw new Error(error.message);
      return { order_number: order.number, order_code: formatOrderCode(order.number), status: "cancelada", status_label: statusLabel("cancelada") };
    }

    case "complete_sale": {
      // Bug fix found while building get_dispatch_status/create_return
      // (2026-08-24): this used to write status: "entregada", but
      // sales_orders.status only allows cotizacion/confirmada/cancelada
      // since the 2026-08-20 order/delivery-status split -- "entregada"
      // was never a valid status after that point, it lives in
      // delivery_status now (pendiente/en_camino/entregado). That update
      // always violated the check constraint, so complete_sale has been
      // throwing on every real call since 2026-08-20 without anyone
      // noticing (its error just looked like "algo salió mal" to the
      // customer). Also dropped the dead "en_proceso" status branch --
      // never a valid value either, resolveLatestOrder covers the one
      // real case (confirmada) fine.
      const order = await resolveLatestOrder(adminClient, tenantId, contactId, "confirmada");
      if (!order) throw new Error("Este cliente no tiene ninguna venta confirmada pendiente de completar.");

      // Con envío físico asociado, la entrega la confirma un humano (o un
      // despacho real con tracking) -- nunca la IA sola. Encontrado en vivo
      // el 2026-08-24: marcaba "entregado" apenas se guardaba la dirección,
      // sin que existiera ningún dispatches real detrás.
      if (order.shipping_address_id) {
        return {
          order_number: order.number,
          order_code: formatOrderCode(order.number),
          blocked: true,
          reason: "shipping_pending",
        };
      }

      const { error } = await adminClient.from("sales_orders").update({ delivery_status: "entregado" }).eq("id", order.id);
      if (error) throw new Error(error.message);
      return { order_number: order.number, order_code: formatOrderCode(order.number), delivery_status: "entregado" };
    }

    case "get_dispatch_status": {
      const order = await resolveLatestOrder(adminClient, tenantId, contactId);
      if (!order) return { found: false };

      const { data: dispatch, error: dispatchError } = await adminClient
        .from("dispatches")
        .select("id, carrier_name, tracking_number, tracking_url, status:dispatch_statuses(name)")
        .eq("tenant_id", tenantId)
        .eq("sales_order_id", order.id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (dispatchError) throw new Error(dispatchError.message);
      if (!dispatch) return { found: false };

      const { data: historyRows } = await adminClient
        .from("dispatch_status_history")
        .select("created_at, status:dispatch_statuses!to_status_id(name)")
        .eq("dispatch_id", dispatch.id)
        .order("created_at", { ascending: false })
        .limit(3);

      return {
        found: true,
        status: (dispatch.status as { name: string } | null)?.name ?? null,
        carrier_name: dispatch.carrier_name,
        tracking_number: dispatch.tracking_number,
        tracking_url: dispatch.tracking_url,
        history: (historyRows ?? []).map((h: { created_at: string; status: { name: string } | null }) => ({
          status: h.status?.name ?? null,
          at: h.created_at,
        })),
      };
    }

    case "create_return": {
      // Delivered is delivery_status = "entregado", not status = "entregada"
      // -- status only tracks cotizacion/confirmada/cancelada (see the
      // complete_sale fix above), so this can't use resolveLatestOrder's
      // status filter and queries directly instead.
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data: order, error: orderError } = await adminClient
        .from("sales_orders")
        .select("id, number")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .eq("delivery_status", "entregado")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (orderError) throw new Error(orderError.message);
      if (!order) throw new Error("Este cliente no tiene ninguna venta entregada sobre la que pedir una devolución.");

      const rawItems = Array.isArray(parameters.items) ? parameters.items : [];
      if (rawItems.length === 0) throw new Error("items es requerido y no puede estar vacío.");
      const reason = String(parameters.reason ?? "").trim();
      if (!reason) throw new Error("reason es requerido.");

      const { data: orderItems, error: orderItemsError } = await adminClient
        .from("sales_order_items")
        .select("id, product_name, quantity")
        .eq("order_id", order.id);
      if (orderItemsError) throw new Error(orderItemsError.message);

      // Solo se puede devolver lo que efectivamente está en esta venta -- no
      // contra el catálogo general (a diferencia de create_quote/add_item_to_quote).
      const returnItemRows = [];
      for (const rawItem of rawItems) {
        const productName = String((rawItem as Record<string, unknown>).product_name ?? "").trim();
        const quantity = Number((rawItem as Record<string, unknown>).quantity);
        if (!productName) throw new Error("Cada línea necesita product_name.");
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error(`Cantidad inválida para "${productName}".`);

        const orderItem = (orderItems ?? []).find((i: { product_name: string }) => i.product_name.toLowerCase() === productName.toLowerCase());
        if (!orderItem) throw new Error(`"${productName}" no está en el pedido ${formatOrderCode(order.number)}.`);
        if (quantity > orderItem.quantity) throw new Error(`Pediste devolver ${quantity} de "${productName}", pero la venta solo tiene ${orderItem.quantity}.`);

        returnItemRows.push({ tenant_id: tenantId, sales_order_item_id: orderItem.id, quantity });
      }

      const { data: initialStatus, error: statusError } = await adminClient
        .from("return_statuses")
        .select("id, name")
        .eq("tenant_id", tenantId)
        .order("display_order", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (statusError) throw new Error(statusError.message);
      if (!initialStatus) throw new Error("Este tenant no tiene estados de devolución configurados todavía.");

      const { data: newReturn, error: returnError } = await adminClient
        .from("returns")
        .insert({ tenant_id: tenantId, sales_order_id: order.id, status_id: initialStatus.id, reason })
        .select("id")
        .single();
      if (returnError) throw new Error(returnError.message);

      const { error: itemsInsertError } = await adminClient
        .from("return_items")
        .insert(returnItemRows.map((row) => ({ ...row, return_id: newReturn.id })));
      if (itemsInsertError) throw new Error(itemsInsertError.message);

      return { order_code: formatOrderCode(order.number), status: initialStatus.name, created: true };
    }

    case "get_return_status": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");

      // A return can belong to any past order of this contact, not just the
      // most recent one -- resolve the contact's order ids first, same
      // scoping principle as resolveLatestOrder, then find the most recent
      // return among those.
      const { data: contactOrders, error: contactOrdersError } = await adminClient
        .from("sales_orders")
        .select("id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .is("deleted_at", null);
      if (contactOrdersError) throw new Error(contactOrdersError.message);
      const orderIds = (contactOrders ?? []).map((o: { id: string }) => o.id);
      if (orderIds.length === 0) return { found: false };

      const { data: match, error: returnError } = await adminClient
        .from("returns")
        .select("reason, resolution_amount, credit_granted, status:return_statuses!status_id(name), order:sales_orders!sales_order_id(number)")
        .eq("tenant_id", tenantId)
        .in("sales_order_id", orderIds)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (returnError) throw new Error(returnError.message);
      if (!match) return { found: false };

      return {
        found: true,
        order_code: formatOrderCode((match.order as { number: number }).number),
        status: (match.status as { name: string } | null)?.name ?? null,
        reason: match.reason,
        resolution_amount: match.resolution_amount != null ? formatCurrencyCOP(match.resolution_amount) : null,
        credit_granted: match.credit_granted,
      };
    }

    case "get_client_profile": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data, error } = await adminClient
        .from("clients")
        .select("full_name, document_type, document_number, email, credit_enabled")
        .eq("id", contactId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data ?? { full_name: null, document_type: null, document_number: null, email: null, credit_enabled: false };
    }

    case "update_client_profile": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const updates: Record<string, string> = {};
      for (const field of ["full_name", "document_type", "document_number", "email"] as const) {
        if (typeof parameters[field] === "string" && (parameters[field] as string).trim()) {
          updates[field] = (parameters[field] as string).trim();
        }
      }
      if (Object.keys(updates).length === 0) throw new Error("No se recibió ningún campo para actualizar.");

      const { data, error } = await adminClient
        .from("clients")
        .update(updates)
        .eq("id", contactId)
        .select("full_name, document_type, document_number, email")
        .single();
      if (error) throw new Error(error.message);
      return { updated: true, ...data };
    }

    case "list_contact_addresses": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data, error } = await adminClient
        .from("contact_addresses")
        .select("id, label, is_shipping, is_billing, is_default, line1, line2, city, state_province, postal_code, country")
        .eq("tenant_id", tenantId)
        .eq("contact_id", contactId)
        .is("deleted_at", null)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return { addresses: data ?? [] };
    }

    case "save_contact_address": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");

      // Only overwrites the fields the model actually sent -- lets "usá la
      // misma de siempre, aplicala a esta venta" be a single call
      // (address_id + apply_as_* only) without touching the rest of an
      // already-saved address.
      const fields: Record<string, unknown> = {};
      const stringFields = ["label", "recipient_name", "phone", "tax_id", "line1", "line2", "city", "state_province", "postal_code", "country", "notes"];
      for (const key of stringFields) {
        if (parameters[key] !== undefined) fields[key] = String(parameters[key]).trim() || null;
      }
      if (typeof parameters.is_shipping === "boolean") fields.is_shipping = parameters.is_shipping;
      if (typeof parameters.is_billing === "boolean") fields.is_billing = parameters.is_billing;

      // Nunca un valor inventado para completar el flujo -- si el cliente no
      // te dio todavía su dirección real, preguntale antes de llamar esta
      // tool. Encontrado en vivo el 2026-08-25: el modelo guardó line1
      // "Dirección no registrada" solo para poder confirmar la venta.
      if (typeof fields.line1 === "string" && isPlaceholderAddressText(fields.line1)) {
        throw new Error(`"${fields.line1}" no es una dirección real, parece un valor de relleno. Preguntale al cliente su dirección real (calle, ciudad) antes de volver a llamar esta herramienta.`);
      }

      // address_id llega como el id real o como el número de opción con el
      // que se le listó la dirección al cliente (`option` de saved_addresses).
      // Encontrado en vivo 2026-09-14, dos veces: el cliente respondió "1", el
      // modelo pasó "1" como address_id y, con un error que le pedía el id
      // real, en vez de corregirse le volvió a preguntar la dirección al
      // cliente. Resolverlo acá elimina ese paso de fallo.
      const addressId = await resolveAddressReference(adminClient, tenantId, contactId, parameters.address_id);
      let savedAddressId = addressId;

      if (addressId) {
        const { error } = await adminClient
          .from("contact_addresses")
          .update(fields)
          .eq("id", addressId)
          .eq("tenant_id", tenantId)
          .eq("contact_id", contactId);
        if (error) throw new Error(error.message);
      } else {
        if (!fields.line1) throw new Error("line1 es requerido para guardar una dirección nueva.");
        if (!fields.city) throw new Error("city es requerido para guardar una dirección nueva -- preguntale al cliente en qué ciudad, no lo dejes vacío.");
        // Sin default a "es de envío" -- una dirección nueva en la etapa de
        // cotización es de facturación, y en la etapa de confirmación es de
        // envío; forzar cuál es evita que quede marcada como la que no es.
        if (fields.is_shipping !== true && fields.is_billing !== true) {
          throw new Error("Indicá is_shipping o is_billing (según en qué paso del flujo estás pidiendo esta dirección) al guardar una dirección nueva.");
        }
        const { data: inserted, error } = await adminClient
          .from("contact_addresses")
          .insert({ tenant_id: tenantId, contact_id: contactId, is_shipping: false, is_billing: false, ...fields, is_default: true })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        savedAddressId = inserted.id;
      }

      const applyAsShipping = parameters.apply_as_shipping === true;
      const applyAsBilling = parameters.apply_as_billing === true;
      // Solo sobre el pedido en armado de esta conversación, o el que el
      // cliente nombró (resolveTargetOrder) -- nunca sobre un pedido
      // anterior por decisión propia del modelo (2026-09-14).
      let appliedToOrder: string | null = null;
      if ((applyAsShipping || applyAsBilling) && savedAddressId) {
        const { order } = await resolveTargetOrder(adminClient, tenantId, contactId, parseOrderNumber(parameters.order_number));
        if (order) {
          const orderUpdate: Record<string, string> = {};
          if (applyAsShipping) orderUpdate.shipping_address_id = savedAddressId;
          if (applyAsBilling) orderUpdate.billing_address_id = savedAddressId;
          const { error: applyError } = await adminClient.from("sales_orders").update(orderUpdate).eq("id", order.id).eq("tenant_id", tenantId);
          if (applyError) throw new Error(applyError.message);
          appliedToOrder = formatOrderCode(order.number);
        }
      }

      return { address_id: savedAddressId, saved: true, applied_to_order: appliedToOrder };
    }

    case "generate_payment_link": {
      // Amount is never taken from the model -- it's always the exact
      // remaining balance of the customer's confirmed order, computed
      // server-side (see createSalesOrderPaymentLink). Found live 2026-08-25
      // designing this: letting the model pass its own `amount` had the
      // same failure mode as the address-placeholder bug -- nothing stopped
      // it from inventing or misreading a number. This also persists a
      // sales_order_payment_links row so payment-webhook-wompi can record
      // the payment on this exact order once the customer actually pays --
      // the old version of this tool generated a real Wompi link that led
      // nowhere once paid.
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const order = await resolveLatestOrder(adminClient, tenantId, contactId, "confirmada");
      if (!order) throw new Error("Este cliente no tiene ningún pedido confirmado para cobrar. Un pedido tiene que estar confirmado (confirm_quote) antes de poder generarle un link de pago.");

      const result = await createSalesOrderPaymentLink(adminClient, tenantId, order.id, null);
      return {
        checkout_url: result.checkoutUrl,
        amount: formatCurrencyCOP(result.amount),
        order_code: result.orderCode,
      };
    }

    case "charge_sale_to_credit": {
      // Same "amount is always the real balance, never invented" discipline
      // as generate_payment_link -- see chargeSalesOrderToCredit's own
      // comment for why this is a plain sales_order_payments insert instead
      // of touching credit_charges directly.
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const order = await resolveLatestOrder(adminClient, tenantId, contactId, "confirmada");
      if (!order) throw new Error("Este cliente no tiene ningún pedido confirmado para cargar a crédito.");

      const result = await chargeSalesOrderToCredit(adminClient, tenantId, contactId, order.id);
      return { charged: true, amount: formatCurrencyCOP(result.amount), order_code: result.orderCode };
    }

    case "hubspot_sync_contact": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const email = String(parameters.email ?? "").trim();
      if (!email) throw new Error("email es requerido");

      const { data: contact } = await adminClient.from("clients").select("phone_prefix, phone, full_name").eq("id", contactId).maybeSingle();

      const properties: Record<string, string> = { email };
      if (contact?.phone) properties.phone = combinePhone(contact.phone_prefix, contact.phone);
      if (parameters.firstname) properties.firstname = String(parameters.firstname).trim();
      else if (contact?.full_name) properties.firstname = contact.full_name;
      if (parameters.lastname) properties.lastname = String(parameters.lastname).trim();
      if (parameters.company) properties.company = String(parameters.company).trim();
      if (parameters.jobtitle) properties.jobtitle = String(parameters.jobtitle).trim();

      const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, "hubspot");
      const token = await makeIntegrationSecretGetter(adminClient, credential.id)("token");
      if (!token) throw new Error("HubSpot no tiene un token configurado para este tenant.");

      const { id, created } = await createOrUpdateContact(token, properties);
      await adminClient.from("clients").update({ hubspot_contact_id: id }).eq("id", contactId);
      return { hubspot_contact_id: id, created };
    }

    case "hubspot_list_deal_pipelines": {
      const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, "hubspot");
      const token = await makeIntegrationSecretGetter(adminClient, credential.id)("token");
      if (!token) throw new Error("HubSpot no tiene un token configurado para este tenant.");
      const pipelines = await getDealPipelines(token);
      return {
        pipelines: pipelines.map((p) => ({
          name: p.label,
          stages: ((p.stages as Array<Record<string, unknown>>) ?? []).map((s) => s.label),
        })),
      };
    }

    case "hubspot_create_deal": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data: contact } = await adminClient.from("clients").select("hubspot_contact_id").eq("id", contactId).maybeSingle();
      if (!contact?.hubspot_contact_id) {
        throw new Error("El contacto todavía no está sincronizado con HubSpot -- llamá a hubspot_sync_contact primero.");
      }

      const dealname = String(parameters.dealname ?? "").trim();
      if (!dealname) throw new Error("dealname es requerido");
      const pipelineName = String(parameters.pipeline_name ?? "").trim();
      const dealstageName = String(parameters.dealstage_name ?? "").trim();
      if (!pipelineName || !dealstageName) throw new Error("pipeline_name y dealstage_name son requeridos");

      const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, "hubspot");
      const token = await makeIntegrationSecretGetter(adminClient, credential.id)("token");
      if (!token) throw new Error("HubSpot no tiene un token configurado para este tenant.");

      const pipelines = await getDealPipelines(token);
      const pipeline = pipelines.find((p) => p.label === pipelineName);
      if (!pipeline) throw new Error(`No existe el pipeline "${pipelineName}" en HubSpot.`);
      const stage = ((pipeline.stages as Array<Record<string, unknown>>) ?? []).find((s) => s.label === dealstageName);
      if (!stage) throw new Error(`No existe la etapa "${dealstageName}" en el pipeline "${pipelineName}".`);

      const properties: Record<string, string> = { dealname, pipeline: String(pipeline.id), dealstage: String((stage as Record<string, unknown>).id) };
      if (parameters.amount !== undefined) properties.amount = String(parameters.amount);
      if (parameters.description) properties.description = String(parameters.description).trim();

      const deal = await createDeal(token, properties, contact.hubspot_contact_id as string);
      return { hubspot_deal_id: deal.id, dealname };
    }

    case "shopify_search_products": {
      const query = String(parameters.query ?? "").trim();
      if (!query) throw new Error("query es requerido");
      const { shop, accessToken } = await resolveShopifyConfig(adminClient, tenantId);
      const products = await searchProducts(shop, accessToken, query);
      return { products };
    }

    case "shopify_search_customer_by_phone": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data: contact } = await adminClient.from("clients").select("phone_prefix, phone").eq("id", contactId).maybeSingle();
      if (!contact?.phone) throw new Error("Este contacto no tiene teléfono registrado.");
      const { shop, accessToken } = await resolveShopifyConfig(adminClient, tenantId);
      const customer = await searchCustomerByPhone(shop, accessToken, combinePhone(contact.phone_prefix, contact.phone));
      return { found: !!customer, customer };
    }

    case "shopify_search_orders": {
      if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");
      const { data: contact } = await adminClient.from("clients").select("phone_prefix, phone").eq("id", contactId).maybeSingle();
      if (!contact?.phone) throw new Error("Este contacto no tiene teléfono registrado.");
      const { shop, accessToken } = await resolveShopifyConfig(adminClient, tenantId);

      // Always resolve the Shopify customer for *this* contact's own phone
      // first, and scope the order search to that customer server-side --
      // the AI's free-text query is only ever a refinement on top of that
      // scope, never the sole filter, so this contact can't retrieve another
      // customer's orders no matter what it searches for.
      const customer = await searchCustomerByPhone(shop, accessToken, combinePhone(contact.phone_prefix, contact.phone));
      if (!customer) return { orders: [], note: "Este contacto no tiene un perfil de cliente en Shopify." };

      const refinement = String(parameters.query ?? "").trim();
      const orders = await searchOrders(shop, accessToken, (customer as { id: string }).id, refinement);
      return { orders };
    }

    default:
      throw new Error(`Unknown function_name: ${functionName}`);
  }
}

/** Resolves this tenant's Shopify credential into the `{shop}.myshopify.com`
 * domain + access token the Admin GraphQL client needs. The credential
 * drawer only stores the bare store name (e.g. "mi-tienda") in config.shop --
 * resolveShopifyDomain both appends ".myshopify.com" and rejects anything
 * that isn't a valid Shopify store name, so a tenant can never point this
 * fetch() at an arbitrary host (SSRF) via a crafted config.shop value. */
// deno-lint-ignore no-explicit-any
async function resolveShopifyConfig(adminClient: any, tenantId: string): Promise<{ shop: string; accessToken: string }> {
  const credential = await resolveTenantIntegrationCredential(adminClient, tenantId, "shopify");
  const shopName = String(credential.config.shop ?? "").trim();
  if (!shopName) throw new Error("Shopify no tiene una tienda configurada para este tenant.");
  const accessToken = await makeIntegrationSecretGetter(adminClient, credential.id)("access_token");
  if (!accessToken) throw new Error("Shopify no tiene un token configurado para este tenant.");
  const shop = resolveShopifyDomain(shopName);
  return { shop, accessToken };
}

/** Resolves a tenant's pipeline by name (case-insensitive, as returned by
 * list_pipelines) plus its lowest-display_order stage -- lets
 * create_opportunity land a new case in whichever pipeline actually fits
 * the customer's need (Ventas, Soporte y Postventa, Onboarding, ...)
 * instead of always defaulting to one fixed pipeline. Every tenant is
 * guaranteed at least the seeded "Ventas" pipeline (seed_default_pipeline
 * trigger fires on tenant creation), so this never has to special-case "no
 * pipeline yet" -- only "no pipeline named that". */
// deno-lint-ignore no-explicit-any
async function resolvePipelineAndFirstStage(
  adminClient: any,
  tenantId: string,
  pipelineName: string,
): Promise<{ pipelineId: string; stageId: string; stageName: string }> {
  const { data: pipelines, error } = await adminClient
    .from("pipelines")
    .select("id, name")
    .eq("tenant_id", tenantId)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  if (!pipelines || pipelines.length === 0) throw new Error("Este tenant no tiene ningún pipeline configurado.");

  // Falls back to the tenant's one pipeline instead of erroring when there's
  // no ambiguity to resolve -- most tenants only ever have the seeded
  // "Ventas" pipeline, and a model that guesses a plausible-sounding name
  // (e.g. "Admisiones" for a university tenant) would otherwise silently
  // fail to create the opportunity while still telling the customer it was
  // registered (found 2026-08-10). Only tenants with more than one pipeline
  // still need the model to get the name right.
  let pipeline = pipelines.find((p: { name: string }) => p.name.toLowerCase() === pipelineName.toLowerCase());
  if (!pipeline && pipelines.length === 1) pipeline = pipelines[0];
  if (!pipeline) {
    const validNames = pipelines.map((p: { name: string }) => p.name).join(", ");
    throw new Error(`Pipeline "${pipelineName}" no existe. Pipelines válidos: ${validNames}`);
  }

  const { data: stage, error: stageError } = await adminClient
    .from("pipeline_stages")
    .select("id, name")
    .eq("pipeline_id", pipeline.id)
    .order("display_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (stageError) throw new Error(stageError.message);
  if (!stage) throw new Error(`El pipeline "${pipeline.name}" no tiene etapas configuradas.`);

  return { pipelineId: pipeline.id, stageId: stage.id, stageName: stage.name };
}

/** Same "most recent X of the contact" pattern as resolveLatestOrder, over
 * opportunities -- lets update_opportunity_stage/get_opportunity_status
 * act without the model having to remember an id across turns. */
// deno-lint-ignore no-explicit-any
async function resolveLatestOpenOpportunity(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  contactId: string | undefined,
): Promise<{ id: string; pipeline_id: string; stage_id: string; title: string }> {
  if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");

  const { data, error } = await adminClient
    .from("opportunities")
    .select("id, pipeline_id, stage_id, title")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .eq("status", "open")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Este cliente todavía no tiene ninguna oportunidad abierta.");
  return data;
}

/** Shared by send_attachment and send_product_image -- both need the same
 * three things to call the Graph API: the line's phone_number_id, its
 * decrypted access token, and the customer's phone. */
// deno-lint-ignore no-explicit-any
async function resolveConversationSendContext(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  conversationId: string,
): Promise<{ phoneNumberId: string; accessToken: string; contactPhone: string }> {
  const { data: conversation, error: convError } = await adminClient
    .from("whatsapp_conversations")
    .select("contact_phone, whatsapp_line_id")
    .eq("id", conversationId)
    .single();
  if (convError || !conversation) throw new Error("No se encontró la conversación.");

  const { data: line, error: lineError } = await adminClient
    .from("whatsapp_lines")
    .select("phone_number_id")
    .eq("id", conversation.whatsapp_line_id)
    .single();
  if (lineError || !line) throw new Error("No se encontró la línea de WhatsApp.");

  const { data: accessToken } = await adminClient.rpc("get_whatsapp_line_access_token", { p_line_id: conversation.whatsapp_line_id });
  if (!accessToken) throw new Error("Esta línea no tiene un token de acceso configurado.");

  return { phoneNumberId: line.phone_number_id, accessToken, contactPhone: conversation.contact_phone };
}

/** Resolve-or-create the `clients` row for this conversation's phone number
 * -- see the call site in executeTool for why this exists. Reads
 * contact_phone/contact_name off whatsapp_conversations (always set by the
 * webhook even when contact_id isn't), re-checks for a matching client by
 * phone (another call in this same turn, or the webhook itself, may have
 * already linked/created one), and persists the link on
 * whatsapp_conversations.contact_id so every later call in this
 * conversation gets it for free. Never throws -- a failure here shouldn't
 * break whatever the model was actually trying to do; the tool call below
 * still gets a clear "no hay contacto" error if this genuinely couldn't
 * resolve one. */
// deno-lint-ignore no-explicit-any
async function resolveOrCreateContact(
  adminClient: any,
  tenantId: string,
  conversationId: string,
  contactId: string | undefined,
): Promise<string | undefined> {
  if (contactId) return contactId;

  const { data: conversation } = await adminClient
    .from("whatsapp_conversations")
    .select("contact_phone, contact_name")
    .eq("id", conversationId)
    .maybeSingle();
  if (!conversation?.contact_phone) return contactId;

  // clients.phone quedó como SOLO el número local desde
  // 20260904000000_clients_phone_prefix_split.sql -- conversation.contact_phone
  // sigue siendo el wa_id completo, hay que partirlo para matchear/crear
  // contra las dos columnas.
  const { dialCode: contactDialCode, localNumber: contactLocalNumber } = splitPhone(conversation.contact_phone);
  const { data: existing } = await adminClient
    .from("clients")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("phone_prefix", contactDialCode)
    .eq("phone", contactLocalNumber)
    .is("deleted_at", null)
    .maybeSingle();

  let newContactId: string | undefined = existing?.id;
  if (!newContactId) {
    const { data: created, error } = await adminClient
      .from("clients")
      .insert({ tenant_id: tenantId, full_name: conversation.contact_name || conversation.contact_phone, phone_prefix: contactDialCode, phone: contactLocalNumber })
      .select("id")
      .single();
    if (error) {
      console.error("resolveOrCreateContact: failed to create client", error);
      return contactId;
    }
    newContactId = created.id;
  }

  await adminClient.from("whatsapp_conversations").update({ contact_id: newContactId }).eq("id", conversationId);
  return newContactId;
}

/** Resolves "the customer's most recent order" (cotización or venta -- same
 * entity, see 20260808000003_crm_orders.sql), optionally narrowed to a
 * specific status (e.g. confirm_quote/cancel_quote only ever act on one
 * still in "cotizacion", never on an already-confirmed venta). */
// deno-lint-ignore no-explicit-any
async function resolveLatestOrder(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  contactId: string | undefined,
  status?: string,
  /** Un pedido puntual por su número (el cliente lo nombró). */
  orderNumber?: number,
): Promise<{
  id: string;
  number: number;
  status: string;
  total: number;
  currency: string;
  notes: string | null;
  shipping_address_id: string | null;
  billing_address_id: string | null;
  opportunity_id: string | null;
  updated_at: string;
} | null> {
  if (!contactId) throw new Error("No hay un contacto vinculado a esta conversación.");

  let query = adminClient
    .from("sales_orders")
    .select("id, number, status, total, currency, notes, shipping_address_id, billing_address_id, opportunity_id, updated_at")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (status) query = query.eq("status", status);
  if (orderNumber !== undefined) query = query.eq("number", orderNumber);

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** "1" -> "001" -- the human-facing code the model should quote back to the
 * customer ("tu cotización 001"), computed here instead of left to the
 * model to pad itself. */
function formatOrderCode(number: number): string {
  return String(number).padStart(3, "0");
}

/** "219900" -> "$219.900" -- same reasoning as formatOrderCode: a real-world
 * test (2026-08-10) showed the model echoing raw numbers verbatim in its
 * quote list ("219900", "109950000") because the prompt tells it to use
 * price/quantity "tal cual te los devuelve la herramienta" -- formatting
 * money is a deterministic, mechanical step that shouldn't depend on the
 * model doing it correctly (or at all) every time. Every price/subtotal/
 * total create_quote and get_quote_status return is pre-formatted here;
 * the model only ever has to print the string it's given. Colombian peso
 * only, no decimals -- matches every currency formatter already in
 * leadly-app's own frontend (Intl.NumberFormat('es-CO', ...)). */
function formatCurrencyCOP(value: number): string {
  return new Intl.NumberFormat("es-CO", { style: "currency", currency: "COP", maximumFractionDigits: 0 }).format(value);
}

/** Same reasoning as formatOrderCode/formatCurrencyCOP: found live 2026-08-25,
 * after confirm_quote actually confirmed a sale, the model told the customer
 * "la cotización ha sido confirmada" -- technically not wrong, but it keeps
 * calling a real, committed sale a "cotización" (a mere price estimate),
 * which is confusing for the customer and for whoever reads the chat later.
 * Every ventas tool that returns an order's status now also returns this
 * ready-to-use label instead of leaving the model to phrase the status
 * itself off the raw enum value. */
function statusLabel(status: string): string {
  switch (status) {
    case "cotizacion":
      return "Cotización (todavía no es una compra en firme)";
    case "confirmada":
      return "Pedido confirmado (venta en firme)";
    case "cancelada":
      return "Cotización cancelada";
    default:
      return status;
  }
}

/** Keeps the pipeline in sync with sales activity that happens entirely
 * over WhatsApp, with no agent loading it into the CRM by hand: reuses the
 * contact's existing open opportunity if it has one (so a customer who's
 * already "Interesado en Audífonos" via create_opportunity doesn't get a
 * second, duplicate card once they actually quote it), otherwise creates
 * one in the tenant's default sales pipeline. Returns null (never throws)
 * on any setup problem -- a tenant with e.g. no pipeline stages configured
 * shouldn't be unable to create a quote just because the pipeline side
 * failed; the quote itself is the important part. */
// deno-lint-ignore no-explicit-any
async function resolveOrCreateOpportunityForQuote(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  contactId: string,
  quoteTotal: number,
): Promise<string | null> {
  try {
    const { data: existing } = await adminClient
      .from("opportunities")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("contact_id", contactId)
      .eq("status", "open")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return existing.id;

    const { data: pipelines } = await adminClient
      .from("pipelines")
      .select("id, name")
      .eq("tenant_id", tenantId)
      .eq("is_active", true);
    if (!pipelines || pipelines.length === 0) return null;
    const pipeline = pipelines.find((p: { name: string }) => p.name.toLowerCase() === "ventas") ?? pipelines[0];

    // A cotización is already a formal proposal, not a fresh lead -- lands
    // on the "Propuesta" stage if the pipeline has one (the default seeded
    // pipeline always does), falling back to the first stage otherwise.
    const { data: stages } = await adminClient
      .from("pipeline_stages")
      .select("id, name, display_order")
      .eq("pipeline_id", pipeline.id)
      .order("display_order", { ascending: true });
    if (!stages || stages.length === 0) return null;
    const stage = stages.find((s: { name: string }) => s.name.toLowerCase() === "propuesta") ?? stages[0];

    const { data: opportunity, error } = await adminClient
      .from("opportunities")
      .insert({
        tenant_id: tenantId,
        pipeline_id: pipeline.id,
        stage_id: stage.id,
        contact_id: contactId,
        title: "Cotización por WhatsApp",
        value: quoteTotal,
        source: "whatsapp_ia",
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return opportunity.id;
  } catch (err) {
    console.error("resolveOrCreateOpportunityForQuote failed", err);
    return null;
  }
}

/** Shared by send_product_image and create_quote -- resolves a single
 * product by the name the model gives it. Two passes: an exact
 * (case-insensitive) match first, since the model is instructed to echo
 * back the precise name list_catalog_products returned; a full-text-search
 * fallback second, for when it paraphrases slightly (plural, reordered
 * words, missing an accent). Never throws -- returns null so the caller can
 * give its own "no encontrado" message with the right product_name in it.
 * No stock columns here -- products carries no stock counter of its own
 * (see types/domain.ts); callers that actually need availability (confirm_quote)
 * fetch it separately via getStockTotals, keyed off the id this returns. */
// deno-lint-ignore no-explicit-any
async function findProductByName(adminClient: any, tenantId: string, name: string): Promise<Record<string, unknown> | null> {
  const columns = "id, name, slug, sku, retail_price, track_inventory, has_variants, is_visible_in_catalog, tax_type_code, tax_rate";

  const { data: exact } = await adminClient
    .from("products")
    .select(columns)
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .ilike("name", name)
    .maybeSingle();
  if (exact) return exact;

  const { data: fuzzy } = await adminClient
    .from("products")
    .select(columns)
    .eq("tenant_id", tenantId)
    .eq("is_active", true)
    .is("deleted_at", null)
    .textSearch("name", name, { type: "plain", config: "spanish" })
    .limit(1);
  return fuzzy && fuzzy.length > 0 ? fuzzy[0] : null;
}

/** True only when this tenant has an active Wompi credential AND both
 * secrets (private_key, events_key) are actually set. Deliberately
 * duplicated from whatsapp-ai-respond's isTenantWompiConnected instead of
 * shared -- same reasoning as formatOrderCode/formatCurrencyCOP below:
 * keeps these two Edge Functions independently deployable. Reads
 * payment_credential_secrets directly (not the payment_credential_configured_secrets
 * RPC) -- that RPC's SECURITY DEFINER body gates on
 * is_superadmin()/auth_active_tenant_id(), both of which need a real user
 * JWT; called with the service-role key those always evaluate false, so
 * the RPC silently returns empty for every tenant (found live 2026-08-25
 * in whatsapp-ai-respond, same bug would reproduce here if copied as-is). */
// deno-lint-ignore no-explicit-any
async function isTenantWompiConnected(adminClient: any, tenantId: string): Promise<boolean> {
  const { data: credential } = await adminClient
    .from("tenant_payment_credentials")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("provider_key", "wompi")
    .eq("is_active", true)
    .is("deleted_at", null)
    .maybeSingle();
  if (!credential) return false;

  const { data: secretRows } = await adminClient.from("payment_credential_secrets").select("secret_name").eq("credential_id", credential.id);
  const secrets = new Set((secretRows ?? []).map((r: { secret_name: string }) => r.secret_name));
  return secrets.has("private_key") && secrets.has("events_key");
}

/** True only when this tenant has the "credit" module turned on
 * (tenant_enabled_modules is presence-based). Same duplication reasoning as
 * isTenantWompiConnected above. */
// deno-lint-ignore no-explicit-any
async function isTenantCreditModuleEnabled(adminClient: any, tenantId: string): Promise<boolean> {
  const { data } = await adminClient.from("tenant_enabled_modules").select("id").eq("tenant_id", tenantId).eq("module_key", "credit").maybeSingle();
  return !!data;
}

/** Runs right after confirm_quote confirms a sale, in the SAME tool call --
 * see the call site's comment for why this can't be left to the model
 * remembering a second, separate tool call afterward. Checks what this
 * specific assistant/tenant/client combination can actually do:
 * - Both credit (client has it enabled, tenant's "Crédito" module is on,
 *   AND the assistant's "credito" skill is on) and Wompi (tenant connected
 *   AND the assistant's "wompi" skill is on) available -> can't decide for
 *   the customer, returns `payment_options` so the model asks which they
 *   prefer, then calls charge_sale_to_credit/generate_payment_link itself.
 * - Only one available -> acts immediately, no need to ask or call a
 *   second tool.
 * - Neither -> `payment_pending: true`, the ventas prompt already knows to
 *   tell the customer an agent will follow up.
 * Never throws -- a failure resolving payment shouldn't undo an
 * already-confirmed sale, same reasoning as the opportunity-move above. */
async function resolvePaymentAfterConfirm(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  conversationId: string,
  contactId: string,
  orderId: string,
): Promise<Record<string, unknown>> {
  try {
    const { data: conversation } = await adminClient.from("whatsapp_conversations").select("whatsapp_line_id").eq("id", conversationId).maybeSingle();
    const { data: line } = conversation
      ? await adminClient.from("whatsapp_lines").select("ai_assistant_id").eq("id", conversation.whatsapp_line_id).maybeSingle()
      : { data: null };
    const assistantId = line?.ai_assistant_id ?? null;
    if (!assistantId) return { payment_pending: true };

    const { data: skillRows } = await adminClient.from("ai_assistant_skills").select("skill_key").eq("ai_assistant_id", assistantId);
    const skillKeys = new Set((skillRows ?? []).map((r: { skill_key: string }) => r.skill_key));

    const { data: client } = await adminClient.from("clients").select("credit_enabled").eq("id", contactId).maybeSingle();

    const creditAvailable = skillKeys.has("credito") && !!client?.credit_enabled && (await isTenantCreditModuleEnabled(adminClient, tenantId));
    const wompiAvailable = skillKeys.has("wompi") && (await isTenantWompiConnected(adminClient, tenantId));

    if (creditAvailable && wompiAvailable) {
      return { payment_options: ["credito", "wompi"] };
    }
    if (creditAvailable) {
      const result = await chargeSalesOrderToCredit(adminClient, tenantId, contactId, orderId);
      return { payment_method: "credito", payment_charged: true, amount: formatCurrencyCOP(result.amount) };
    }
    if (wompiAvailable) {
      const result = await createSalesOrderPaymentLink(adminClient, tenantId, orderId, null);
      return { payment_method: "wompi", checkout_url: result.checkoutUrl, amount: formatCurrencyCOP(result.amount) };
    }
    return { payment_pending: true };
  } catch (err) {
    console.error(`resolvePaymentAfterConfirm failed for order ${orderId}`, err);
    return { payment_pending: true };
  }
}

/** Rechaza armar/ampliar un pedido si alguna línea pide más de lo que hay,
 * con un mensaje que le dice al modelo qué contarle al cliente. Va ANTES de
 * escribir nada: el objetivo (2026-09-14) es que la falta de stock salga
 * mientras el cliente todavía está eligiendo, no después de pedirle datos. */
// deno-lint-ignore no-explicit-any
async function assertStockForQuote(adminClient: any, tenantId: string, items: StockCheckItem[]): Promise<void> {
  const shortfalls = await findStockShortfalls(adminClient, tenantId, items);
  if (shortfalls.length === 0) return;
  const detail = shortfalls.map((s) => `${s.product_name}: pidió ${s.requested}, hay ${Math.max(0, s.available)} disponible(s)`).join("; ");
  throw new Error(
    `Stock insuficiente, no se armó el pedido -- ${detail}. Díselo al cliente en este mismo mensaje con la cantidad disponible y ofrécele una referencia que sí haya (list_product_variants marca in_stock). No le pidas datos ni sigas con la compra hasta resolver esto.`,
  );
}

/** Stock sumado por variante (todas las bodegas) de un producto. */
// deno-lint-ignore no-explicit-any
async function getStockByVariant(adminClient: any, tenantId: string, productId: string): Promise<Map<string, number>> {
  const { data, error } = await adminClient
    .from("product_stock")
    .select("variant_id, quantity")
    .eq("tenant_id", tenantId)
    .eq("product_id", productId)
    .not("variant_id", "is", null);
  if (error) throw new Error(error.message);
  const totals = new Map<string, number>();
  for (const row of (data ?? []) as { variant_id: string; quantity: number }[]) {
    totals.set(row.variant_id, (totals.get(row.variant_id) ?? 0) + row.quantity);
  }
  return totals;
}

/** Enlace de la tienda pública del tenant, o null si no la tiene activa (sin
 * slug o storefront_enabled en false) -- en ese caso el modelo no debe
 * mencionar ninguna tienda. */
// deno-lint-ignore no-explicit-any
async function getStorefrontUrl(adminClient: any, tenantId: string): Promise<string | null> {
  const { data, error } = await adminClient.from("tenants").select("storefront_enabled, storefront_slug").eq("id", tenantId).maybeSingle();
  if (error) {
    console.error(`getStorefrontUrl failed for tenant ${tenantId}`, error);
    return null;
  }
  if (!data?.storefront_enabled || !data.storefront_slug) return null;
  return `${PUBLIC_APP_URL}/tienda/${encodeURIComponent(data.storefront_slug)}`;
}

/** Enlace de un producto en la tienda pública -- misma ruta que arma el
 * frontend (ProductCard.tsx: /tienda/:slug/producto/:slug-o-id). Solo si
 * la tienda está activa y el producto está publicado en ella
 * (is_visible_in_catalog); si no, ese enlace terminaría en "no encontrado".
 * Pedido del usuario 2026-09-14: que cada producto traiga su URL. */
function buildProductUrl(storefrontUrl: string | null, product: { id?: unknown; slug?: unknown; is_visible_in_catalog?: unknown }): string | null {
  if (!storefrontUrl || product.is_visible_in_catalog !== true) return null;
  const reference = product.slug ? String(product.slug) : product.id ? String(product.id) : null;
  return reference ? `${storefrontUrl}/producto/${encodeURIComponent(reference)}` : null;
}

/** Dirección guardada a partir de lo que mande el modelo: el address_id real
 * tal cual, o un número de opción ("1", "opción 2") resuelto contra
 * listAddressesForConversation -- la misma lista, en el mismo orden, que el
 * modelo recibió en saved_addresses. */
async function resolveAddressReference(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  contactId: string,
  value: unknown,
): Promise<string | null> {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const raw = String(value).trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw;

  const option = parseOrderNumber(raw);
  const addresses = await listAddressesForConversation(adminClient, tenantId, contactId);
  const match = option !== null ? addresses.find((a) => a.option === option) : undefined;
  if (!match) {
    const choices = addresses.map((a) => `${a.option}) ${a.address} [address_id ${a.address_id}]`).join("; ") || "ninguna";
    throw new Error(
      `"${raw}" no corresponde a ninguna dirección guardada. Opciones: ${choices}. Vuelve a llamar esta herramienta con una de ellas en este mismo turno, sin preguntarle de nuevo al cliente.`,
    );
  }
  return match.address_id;
}

type OrderRow = NonNullable<Awaited<ReturnType<typeof resolveLatestOrder>>>;

function isRecentlyTouched(order: OrderRow): boolean {
  return Date.parse(order.updated_at) >= Date.now() - OPEN_QUOTE_MAX_AGE_HOURS * 60 * 60 * 1000;
}

/** "049", 49, "#49", "pedido 049" -> 49. null si no viene o no trae dígitos. */
function parseOrderNumber(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits ? Number(digits) : null;
}

/** El pedido sobre el que puede actuar la IA: add_item_to_quote,
 * confirm_quote, cancel_quote y aplicar direcciones.
 *
 * Pedido explícito del usuario (2026-09-14): "la ia no debe tocar
 * cotizaciones viejas ni nada de eso a menos que el cliente lo pida" --
 * solo si pregunta puntualmente por un número de pedido y si lo puede
 * modificar.
 * - Con `orderNumber` (el cliente nombró el pedido): ese pedido del
 *   contacto, sin límite de antigüedad. `order` sale null si ya no está en
 *   cotización -- no se puede modificar por este medio.
 * - Sin él: solo el pedido MÁS RECIENTE del contacto, cualquiera sea su
 *   estado, y solo si sigue en cotización y se tocó en las últimas
 *   OPEN_QUOTE_MAX_AGE_HOURS. Nunca cae a una cotización más vieja cuando
 *   el más reciente ya se confirmó: eso fue exactamente lo que falló en
 *   vivo el 2026-09-13 (confirm_quote tomó una cotización del día anterior
 *   con 51 unidades y dijo que no había stock).
 * `latest` siempre trae lo que se encontró, para armar el mensaje de error. */
async function resolveTargetOrder(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  contactId: string | undefined,
  orderNumber: number | null,
): Promise<{ order: OrderRow | null; latest: OrderRow | null }> {
  if (orderNumber !== null) {
    const found = await resolveLatestOrder(adminClient, tenantId, contactId, undefined, orderNumber);
    return { order: found && found.status === "cotizacion" ? found : null, latest: found };
  }
  const latest = await resolveLatestOrder(adminClient, tenantId, contactId);
  if (!latest) return { order: null, latest: null };
  return { order: latest.status === "cotizacion" && isRecentlyTouched(latest) ? latest : null, latest };
}

function orderNotOpenError(latest: OrderRow | null, orderNumber: number | null, action: string): Error {
  if (orderNumber !== null) {
    if (!latest) return new Error(`No se encontró el pedido ${formatOrderCode(orderNumber)} entre los pedidos de este cliente.`);
    return new Error(
      `El pedido ${formatOrderCode(latest.number)} (${statusLabel(latest.status)}) ya no se puede ${action} por este medio -- díselo al cliente y ofrécele que un asesor lo revise.`,
    );
  }
  return new Error(
    `No hay un pedido en armado en esta conversación para ${action}. Si el cliente quiere comprar, arma uno nuevo con create_quote. No uses pedidos anteriores salvo que el cliente nombre su número y pida modificarlo (order_number).`,
  );
}

/** Direcciones guardadas del cliente, en texto y sin repetidas, para que el
 * modelo se las liste y le pregunte cuál usar (2026-09-14). */
async function listAddressesForConversation(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  tenantId: string,
  contactId: string,
): Promise<{ option: number; address_id: string; address: string; used_for: string[] }[]> {
  const { data, error } = await adminClient
    .from("contact_addresses")
    .select("id, line1, line2, city, is_shipping, is_billing")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);

  const normalize = (value: string | null) => (value ?? "").toLowerCase().normalize("NFD").replace(/[^a-z0-9ñ]/g, "");
  const byKey = new Map<string, { address_id: string; address: string; used_for: Set<string> }>();
  for (const row of (data ?? []) as { id: string; line1: string | null; line2: string | null; city: string | null; is_shipping: boolean; is_billing: boolean }[]) {
    if (!row.line1 || isPlaceholderAddressText(row.line1)) continue;
    // "carrera 26 # 2i 24, Neiva" y "Carrera 26 # 2i 24 Neiva" son la misma
    // dirección para el cliente: se lista una sola vez, juntando para qué
    // se usa cada copia, y sin repetir la ciudad si ya viene en la línea.
    const street = [row.line1, row.line2].filter(Boolean).join(" ");
    const city = normalize(row.city);
    const streetKey = normalize(street);
    const key = city && streetKey.endsWith(city) ? streetKey.slice(0, -city.length) : streetKey;
    const existing = byKey.get(key);
    const entry = existing ?? {
      address_id: row.id,
      address: row.city && !(city && streetKey.endsWith(city)) ? `${street}, ${row.city}` : street,
      used_for: new Set<string>(),
    };
    if (row.is_shipping) entry.used_for.add("envío");
    if (row.is_billing) entry.used_for.add("facturación");
    if (!existing) {
      if (byKey.size === 3) continue;
      byKey.set(key, entry);
    }
  }
  // `option` es el número con el que el modelo le lista cada dirección al
  // cliente -- save_contact_address lo acepta en address_id (ver
  // resolveAddressReference).
  const addresses = [...byKey.values()].map((entry, index) => ({ option: index + 1, address_id: entry.address_id, address: entry.address, used_for: [...entry.used_for] }));
  return addresses;
}

/** "Carrera 26 # 2i 24, Neiva" -- para que el modelo le diga al cliente a
 * dónde va el pedido. */
// deno-lint-ignore no-explicit-any
async function describeAddress(adminClient: any, addressId: string): Promise<string | null> {
  const { data } = await adminClient.from("contact_addresses").select("line1, line2, city").eq("id", addressId).maybeSingle();
  if (!data) return null;
  const text = [data.line1, data.line2, data.city].filter(Boolean).join(", ");
  return text || null;
}

/** Pie de foto del producto: la ficha va DENTRO del mensaje de la imagen
 * (caption de WhatsApp), no en un mensaje de texto aparte.
 *
 * Pedido explícito del usuario (2026-09-13): "cuando pregunten por un
 * producto muestre la imagen y bajo la imagen las referencias del producto,
 * todo bajo la misma imagen". En WhatsApp eso es exactamente el caption --
 * una foto y un texto suelto llegan como dos mensajes distintos, y el
 * cliente los ve separados (a veces hasta en otro orden).
 *
 * Lleva nombre, precio y las referencias reales del producto (sus variantes
 * si las tiene; si no, el SKU cuando existe), más la descripción recortada.
 * El tope de un caption de WhatsApp son 1024 caracteres -- se recorta antes
 * de llegar ahí, porque pasarse hace fallar el envío entero.
 *
 * ⚠️ Acoplado con el prompt_fragment de la habilidad `catalogo`, que le dice
 * al modelo que NO repita estos mismos datos en su respuesta de texto. Si
 * este caption cambia (se le agregan o quitan campos), hay que actualizar
 * ese fragmento en la misma ronda: es global, así que una desalineación
 * afecta a los agentes de TODOS los tenants, no solo al que la motivó. */
// deno-lint-ignore no-explicit-any
async function buildProductImageCaption(adminClient: any, productId: string): Promise<string | undefined> {
  try {
    const { data: product } = await adminClient
      .from("products")
      .select("id, tenant_id, name, slug, sku, retail_price, description, has_variants, track_inventory, is_visible_in_catalog")
      .eq("id", productId)
      .maybeSingle();
    if (!product) return undefined;

    const lines: string[] = [`*${product.name}*`, formatCurrencyCOP(product.retail_price)];

    // Solo las referencias con stock (2026-09-14): el cliente elige mirando
    // esta lista, así que una agotada acá es exactamente la venta que
    // después se cae. Sin nada disponible, lo dice en la misma ficha.
    const tracksInventory = !!product.track_inventory;
    if (product.has_variants) {
      const { data: variants } = await adminClient
        .from("product_variants")
        .select("id, option1_value, option2_value, option3_value, sku")
        .eq("product_id", productId)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("created_at", { ascending: true });
      const variantStock = tracksInventory ? await getStockByVariant(adminClient, product.tenant_id, productId) : null;
      const labels = (variants ?? [])
        .filter((v: { id: string }) => !variantStock || (variantStock.get(v.id) ?? 0) > 0)
        .map((v: { option1_value: string | null; option2_value: string | null; option3_value: string | null }) =>
          [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(" / "),
        )
        .filter((label: string) => label.length > 0);
      if (labels.length > 0) lines.push("", `Referencias disponibles: ${labels.join(" · ")}`);
      else if (tracksInventory && (variants ?? []).length > 0) lines.push("", "Agotado por ahora");
    } else {
      if (product.sku) lines.push("", `Referencia: ${product.sku}`);
      if (tracksInventory) {
        const totals = await getStockTotals(adminClient, product.tenant_id, [productId]);
        if ((totals.get(productId)?.available ?? 0) <= 0) lines.push("", "Agotado por ahora");
      }
    }

    // Enlace del producto en la tienda, antes de la descripción: si el
    // caption se recorta por largo, se pierde texto, nunca el enlace.
    const storeProductUrl = buildProductUrl(await getStorefrontUrl(adminClient, product.tenant_id), product);
    if (storeProductUrl) lines.push("", `Ver en la tienda: ${storeProductUrl}`);

    if (product.description) {
      const description = String(product.description).replace(/\s+/g, " ").trim();
      lines.push("", description.length > 400 ? `${description.slice(0, 400)}…` : description);
    }

    const caption = lines.join("\n");
    return caption.length > 1000 ? `${caption.slice(0, 1000)}…` : caption;
  } catch (err) {
    // Un caption que no se pudo armar nunca bloquea el envío de la foto.
    console.error(`buildProductImageCaption failed for product ${productId}`, err);
    return undefined;
  }
}

/** Best-effort: sends a product's first photo via WhatsApp and logs it in
 * the ledger, called automatically from list_catalog_products when a
 * `search` resolves to exactly one product. Found live 2026-08-25: even
 * with an explicit prompt instruction to call send_product_image right
 * after showing a product's detail, the model skipped it twice in a row for
 * two different products that DID have photos -- moving the send into the
 * lookup call the model already has to make (it can't answer at all without
 * calling this) removes the second, unreliable step entirely. Never
 * throws: a product without a photo yet, or a transient send failure, just
 * means false comes back -- the caller decides what (if anything) to tell
 * the model about it, this never blocks the product data itself. */
// deno-lint-ignore no-explicit-any
async function trySendSingleProductImage(adminClient: any, conversationId: string, productId: string): Promise<boolean> {
  try {
    const { data: image } = await adminClient
      .from("product_images")
      .select("storage_path")
      .eq("product_id", productId)
      .order("display_order", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (!image) return false;

    const { data: publicUrlData } = adminClient.storage.from("product-images").getPublicUrl(image.storage_path);
    const sendContext = await resolveConversationSendContext(adminClient, conversationId);
    const caption = await buildProductImageCaption(adminClient, productId);
    const sendResult = await sendWhatsappImage(sendContext.phoneNumberId, sendContext.accessToken, sendContext.contactPhone, publicUrlData.publicUrl, caption);
    if (!sendResult.ok) return false;

    await adminClient.from("whatsapp_messages").insert({
      conversation_id: conversationId,
      direction: "outbound",
      sender_type: "ia",
      content: "[Imagen enviada]",
      wamid: sendResult.wamid,
    });
    return true;
  } catch (err) {
    console.error(`trySendSingleProductImage failed for product ${productId}`, err);
    return false;
  }
}

/** Resolves a product's variant by its combined label (option1/2/3_value
 * joined with " / ", same shape list_product_variants returns) --
 * case-insensitive, since real tenant data has inconsistent casing (seen:
 * "Rojo" next to "azul"/"negro"). */
// deno-lint-ignore no-explicit-any
async function findVariantByLabel(adminClient: any, tenantId: string, productId: string, label: string): Promise<Record<string, unknown> | null> {
  const { data } = await adminClient
    .from("product_variants")
    .select("id, sku, retail_price, option1_value, option2_value, option3_value")
    .eq("tenant_id", tenantId)
    .eq("product_id", productId)
    .eq("is_active", true)
    .is("deleted_at", null);

  const target = label.trim().toLowerCase();
  for (const variant of (data ?? []) as { option1_value: string | null; option2_value: string | null; option3_value: string | null }[]) {
    const variantLabel = [variant.option1_value, variant.option2_value, variant.option3_value].filter(Boolean).join(" / ");
    if (variantLabel.toLowerCase() === target) return variant;
  }
  return null;
}

/** Just the label strings for a product's active variants -- used to embed
 * the real options directly into create_quote/add_item_to_quote's "falta
 * variant" error, so the model can ask the customer in the very next reply
 * instead of needing a separate list_product_variants round-trip first.
 * Found live 2026-08-24: without this, a rejected item sometimes sent the
 * model into an unproductive tool-calling loop instead of just asking. */
// deno-lint-ignore no-explicit-any
async function listVariantLabels(adminClient: any, tenantId: string, productId: string): Promise<string[]> {
  const { data } = await adminClient
    .from("product_variants")
    .select("option1_value, option2_value, option3_value")
    .eq("tenant_id", tenantId)
    .eq("product_id", productId)
    .eq("is_active", true)
    .is("deleted_at", null);
  return (data ?? []).map((v: { option1_value: string | null; option2_value: string | null; option3_value: string | null }) =>
    [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(" / "),
  );
}
