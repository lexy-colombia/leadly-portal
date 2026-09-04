// Backend de la tienda pública por tenant (marketplace, ver CLAUDE.md) --
// reemplaza el enfoque anterior de "link de carrito por pedido"
// (public-cart, borrado): acá no existe ningún pedido ni cliente todavía
// cuando alguien entra, el visitante navega el catálogo completo, arma su
// propio carrito de invitado, y recién se identifica al pagar.
//
// Público y sin JWT (--no-verify-jwt, mismo criterio que whatsapp-webhook y
// el extinto public-cart): el tenant se resuelve siempre por `slug` (nunca
// por un `tenant_id` que mande el cliente), y el carrito por su
// `session_token` aleatorio -- ninguna acción confía en un id que el
// visitante pueda inventar o adivinar.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders, json } from "../_shared/cors.ts";
import { confirmSalesOrder } from "../_shared/orders/confirmSalesOrder.ts";
import { persistOrderItems, type ResolvedOrderItem } from "../_shared/orders/persistOrderItems.ts";
import { chargeSalesOrderToCredit, createSalesOrderPaymentLink } from "../_shared/payments/salesOrderPayments.ts";
import { sendWhatsappTemplate } from "../_shared/whatsapp.ts";
import { splitPhone } from "../_shared/phone.ts";

const CATALOG_PAGE_SIZE = 20;
const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RATE_LIMIT_WINDOW_MINUTES = 15;
const OTP_RATE_LIMIT_MAX = 3;
const OTP_VERIFIED_VALID_MINUTES = 30;

class StorefrontError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = String(body.action ?? "").trim();
  if (!action) return json({ error: "action es requerido" }, 400);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  try {
    const result = await handleAction(adminClient, action, body);
    return json(result, 200);
  } catch (err) {
    const status = err instanceof StorefrontError ? err.status : 500;
    const message = err instanceof Error ? err.message : "Error inesperado";
    if (status === 500) console.error(`storefront action "${action}" failed`, err);
    return json({ error: message }, status);
  }
});

async function resolveStorefront(adminClient: SupabaseClient, slug: string): Promise<{ id: string; name: string; logo_url: string | null }> {
  const { data: tenant, error } = await adminClient
    .from("tenants")
    .select("id, name, logo_url, storefront_enabled")
    .eq("storefront_slug", slug)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!tenant || !tenant.storefront_enabled) throw new StorefrontError("Esta tienda no existe.", 404);
  return { id: tenant.id, name: tenant.name, logo_url: tenant.logo_url };
}

async function resolveCart(adminClient: SupabaseClient, sessionToken: string): Promise<{ id: string; tenant_id: string; status: string }> {
  const { data: cart, error } = await adminClient
    .from("storefront_carts")
    .select("id, tenant_id, status")
    .eq("session_token", sessionToken)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!cart) throw new StorefrontError("Este carrito no existe.", 404);
  return cart;
}

function assertCartOpen(cart: { status: string }) {
  if (cart.status !== "active") throw new StorefrontError("Este carrito ya fue completado.", 409);
}

async function handleAction(adminClient: SupabaseClient, action: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (action) {
    case "get_storefront": {
      const slug = String(body.slug ?? "").trim();
      if (!slug) throw new StorefrontError("slug es requerido.");
      const tenant = await resolveStorefront(adminClient, slug);
      return { name: tenant.name, logo_url: tenant.logo_url };
    }

    case "list_categories": {
      const slug = String(body.slug ?? "").trim();
      if (!slug) throw new StorefrontError("slug es requerido.");
      const tenant = await resolveStorefront(adminClient, slug);
      // Se devuelve la fila completa (no solo id/name): el frontend reutiliza
      // el mismo CategoryTreeFilter + descendantIds que ya usa el catálogo
      // interno del tenant (Products.tsx), y esos esperan la forma completa
      // de ProductCategory (parent_category_id incluido, para armar el árbol).
      const { data, error } = await adminClient
        .from("product_categories")
        .select("id, tenant_id, name, description, parent_category_id, is_active, deleted_at, deleted_by, created_at, updated_at")
        .eq("tenant_id", tenant.id)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (error) throw new Error(error.message);
      return { categories: data ?? [] };
    }

    case "list_brands": {
      const slug = String(body.slug ?? "").trim();
      if (!slug) throw new StorefrontError("slug es requerido.");
      const tenant = await resolveStorefront(adminClient, slug);
      const { data, error } = await adminClient
        .from("brands")
        .select("id, tenant_id, name, description, logo_url, is_active, deleted_at, deleted_by, created_at, updated_at")
        .eq("tenant_id", tenant.id)
        .eq("is_active", true)
        .is("deleted_at", null)
        .order("name", { ascending: true });
      if (error) throw new Error(error.message);
      return { brands: data ?? [] };
    }

    case "list_products": {
      const slug = String(body.slug ?? "").trim();
      if (!slug) throw new StorefrontError("slug es requerido.");
      const tenant = await resolveStorefront(adminClient, slug);
      const search = body.search ? String(body.search).trim() : "";
      const brandId = body.brand_id ? String(body.brand_id).trim() : "";
      // El árbol de categorías (con sus descendientes) se resuelve en el
      // frontend con descendantIds -- acá solo se filtra por el conjunto de
      // ids ya resuelto, mismo criterio que Products.tsx (el catálogo interno
      // del tenant) para no reimplementar la lógica de árbol dos veces.
      const categoryIds = Array.isArray(body.category_ids) ? (body.category_ids as unknown[]).map((id) => String(id)) : [];
      const sort = String(body.sort ?? "name_asc");
      // Scroll infinito: de a CATALOG_PAGE_SIZE, no toda la lista de una --
      // pedido explícito del usuario, la carga inicial del catálogo completo
      // (hasta 120 productos) se sentía pesada. `offset` lo maneja el
      // frontend acumulando cuántos productos ya cargó; acá se pide
      // `limit + 1` filas y se recorta una para saber si hay más página sin
      // gastar una consulta de count aparte.
      const offset = Math.max(0, Number(body.offset) || 0);
      const limit = Math.min(CATALOG_PAGE_SIZE, Math.max(1, Number(body.limit) || CATALOG_PAGE_SIZE));

      let categoryProductIds: string[] | null = null;
      if (categoryIds.length > 0) {
        const { data: links } = await adminClient.from("product_category_links").select("product_id").eq("tenant_id", tenant.id).in("category_id", categoryIds);
        categoryProductIds = [...new Set((links ?? []).map((l: { product_id: string }) => l.product_id))];
        if (categoryProductIds.length === 0) return { products: [], has_more: false };
      }

      const columns =
        "id, name, sku, retail_price, has_variants, track_inventory, created_at, brand:brands(name), categories:product_category_links(category:product_categories(name))";
      function applySort<T>(q: T): T {
        // deno-lint-ignore no-explicit-any
        const query = q as any;
        if (sort === "price_asc") return query.order("retail_price", { ascending: true });
        if (sort === "price_desc") return query.order("retail_price", { ascending: false });
        if (sort === "newest") return query.order("created_at", { ascending: false });
        return query.order("name", { ascending: true });
      }

      // Se pide `limit + 1` (via range) y se recorta la fila de más abajo --
      // barato para saber si hay una página siguiente sin una consulta de
      // count aparte.
      let query = adminClient
        .from("products")
        .select(columns)
        .eq("tenant_id", tenant.id)
        .eq("is_active", true)
        .eq("is_visible_in_catalog", true)
        .is("deleted_at", null)
        .range(offset, offset + limit);
      query = applySort(query);
      if (categoryProductIds) query = query.in("id", categoryProductIds);
      if (brandId) query = query.eq("brand_id", brandId);
      if (search) query = query.textSearch("name", search, { type: "plain", config: "spanish" });

      let { data, error } = await query;
      if (error) throw new Error(error.message);
      if (search && (!data || data.length === 0)) {
        let fallbackQuery = adminClient
          .from("products")
          .select(columns)
          .eq("tenant_id", tenant.id)
          .eq("is_active", true)
          .eq("is_visible_in_catalog", true)
          .is("deleted_at", null)
          .ilike("name", `%${search}%`)
          .range(offset, offset + limit);
        fallbackQuery = applySort(fallbackQuery);
        if (categoryProductIds) fallbackQuery = fallbackQuery.in("id", categoryProductIds);
        if (brandId) fallbackQuery = fallbackQuery.eq("brand_id", brandId);
        const fallback = await fallbackQuery;
        if (fallback.error) throw new Error(fallback.error.message);
        data = fallback.data;
      }

      const hasMore = (data ?? []).length > limit;
      if (hasMore) data = (data ?? []).slice(0, limit);

      const productIds = (data ?? []).map((p: { id: string }) => p.id);
      const images = await loadFirstImages(adminClient, productIds);
      const { stockByProduct, stockByVariant } = await loadStock(adminClient, tenant.id, productIds);
      const variantProductIds = (data ?? []).filter((p: { has_variants: boolean }) => p.has_variants).map((p: { id: string }) => p.id);
      const productPriceById = new Map((data ?? []).map((p: { id: string; retail_price: number }) => [p.id, p.retail_price]));
      const variantsByProduct = await loadVariantsByProduct(adminClient, tenant.id, variantProductIds, stockByVariant, productPriceById);

      // deno-lint-ignore no-explicit-any
      const products = (data ?? []).map((p: any) => {
        const variants = p.has_variants ? (variantsByProduct.get(p.id) ?? []) : undefined;
        // Pedido explícito del usuario (2026-08-26): a diferencia de
        // list_catalog_products (IA), que deliberadamente nunca expone stock
        // -- acá SÍ, para poder agregar al carrito y ver disponibilidad
        // directo desde la grilla sin entrar al detalle. track_inventory en
        // false significa que el tenant no lleva ese control -- se trata
        // como "siempre disponible" (available: null, sin límite conocido).
        const available = !p.track_inventory ? null : p.has_variants ? (variants ?? []).reduce((sum: number, v: { available: number }) => sum + v.available, 0) : (stockByProduct.get(p.id) ?? 0);
        return {
          id: p.id,
          name: p.name,
          sku: p.sku,
          brand_name: p.brand?.name ?? null,
          price: p.retail_price,
          has_variants: p.has_variants,
          image_url: images.get(p.id) ?? null,
          available,
          variants,
          // deno-lint-ignore no-explicit-any
          categories: (p.categories ?? []).map((c: any) => c.category?.name).filter(Boolean),
        };
      });
      return { products, has_more: hasMore };
    }

    case "get_product": {
      const slug = String(body.slug ?? "").trim();
      const productId = String(body.product_id ?? "").trim();
      if (!slug) throw new StorefrontError("slug es requerido.");
      if (!productId) throw new StorefrontError("product_id es requerido.");
      const tenant = await resolveStorefront(adminClient, slug);

      const { data: product, error } = await adminClient
        .from("products")
        .select("id, name, description, retail_price, has_variants, categories:product_category_links(category:product_categories(name))")
        .eq("id", productId)
        .eq("tenant_id", tenant.id)
        .eq("is_active", true)
        .eq("is_visible_in_catalog", true)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!product) throw new StorefrontError("Producto no encontrado.", 404);

      const { data: imageRows } = await adminClient
        .from("product_images")
        .select("storage_path, variant_id")
        .eq("product_id", productId)
        .order("display_order", { ascending: true });
      const images = (imageRows ?? []).map((img: { storage_path: string; variant_id: string | null }) => ({
        url: adminClient.storage.from("product-images").getPublicUrl(img.storage_path).data.publicUrl,
        variant_id: img.variant_id,
      }));

      let variants: Record<string, unknown>[] = [];
      if (product.has_variants) {
        const { data: variantRows } = await adminClient
          .from("product_variants")
          .select("id, retail_price, option1_value, option2_value, option3_value")
          .eq("tenant_id", tenant.id)
          .eq("product_id", productId)
          .eq("is_active", true)
          .is("deleted_at", null);
        variants = (variantRows ?? []).map(
          (v: { id: string; retail_price: number | null; option1_value: string | null; option2_value: string | null; option3_value: string | null }) => ({
            id: v.id,
            label: [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(" / "),
            price: v.retail_price ?? product.retail_price,
          }),
        );
      }

      return {
        id: product.id,
        name: product.name,
        description: product.description,
        price: product.retail_price,
        has_variants: product.has_variants,
        // deno-lint-ignore no-explicit-any
        categories: (product.categories ?? []).map((c: any) => c.category?.name).filter(Boolean),
        images,
        variants,
      };
    }

    case "get_cart": {
      const sessionToken = body.session_token ? String(body.session_token).trim() : "";
      if (!sessionToken) return { items: [] };
      const cart = await resolveCart(adminClient, sessionToken);
      return { status: cart.status, items: await loadCartItems(adminClient, cart.id) };
    }

    case "add_to_cart": {
      const productId = String(body.product_id ?? "").trim();
      const variantIdParam = body.variant_id ? String(body.variant_id).trim() : "";
      const quantity = Number(body.quantity);
      if (!productId) throw new StorefrontError("product_id es requerido.");
      if (!Number.isFinite(quantity) || quantity <= 0) throw new StorefrontError("Cantidad inválida.");

      const sessionToken = body.session_token ? String(body.session_token).trim() : "";
      const slug = String(body.slug ?? "").trim();
      if (!sessionToken && !slug) throw new StorefrontError("slug es requerido para iniciar un carrito nuevo.");

      // El carrito existente (por token) y el tenant (por slug) son lookups
      // independientes -- el frontend siempre manda el slug en cada request,
      // no solo cuando hace falta crear un carrito nuevo -- así que se
      // resuelven en paralelo en vez de esperar uno para recién arrancar el
      // otro. Este paralelismo, más el de abajo, es lo que baja los ~7
      // round-trips secuenciales que tenía esta acción (la causa real de la
      // demora al agregar un producto) a 3 tandas.
      const [existingCartRow, tenant] = await Promise.all([
        sessionToken
          ? adminClient
              .from("storefront_carts")
              .select("id, tenant_id, status, session_token")
              .eq("session_token", sessionToken)
              .maybeSingle()
              .then((r) => r.data as { id: string; tenant_id: string; status: string; session_token: string } | null)
          : Promise.resolve(null),
        slug ? resolveStorefront(adminClient, slug) : Promise.resolve(null),
      ]);

      // A diferencia de las demás acciones, acá un session_token que ya no
      // resuelve a ningún carrito (el visitante volvió con un localStorage
      // viejo de un carrito que se completó o se limpió del lado del
      // servidor) NO es un error -- desde su perspectiva solo quiere agregar
      // el producto, así que se le arma un carrito nuevo en silencio en vez
      // de mostrarle "este carrito no existe".
      let cart: { id: string; tenant_id: string; session_token: string };
      if (existingCartRow && existingCartRow.status === "active") {
        cart = existingCartRow;
      } else {
        if (!tenant) throw new StorefrontError("slug es requerido para iniciar un carrito nuevo.");
        const { data: created, error } = await adminClient
          .from("storefront_carts")
          .insert({ tenant_id: tenant.id })
          .select("id, tenant_id, status, session_token")
          .single();
        if (error) throw new Error(error.message);
        cart = created;
      }

      // Validación de producto/variante + búsqueda del ítem que ya podría
      // estar en el carrito, las 3 en paralelo -- son lookups independientes
      // entre sí, solo dependen del cart/tenant ya resuelto arriba (nunca
      // del resultado de las otras dos).
      const [productResult, variantResult, existingItemResult] = await Promise.all([
        adminClient
          .from("products")
          .select("id, has_variants, retail_price")
          .eq("id", productId)
          .eq("tenant_id", cart.tenant_id)
          .eq("is_active", true)
          .eq("is_visible_in_catalog", true)
          .is("deleted_at", null)
          .maybeSingle(),
        variantIdParam
          ? adminClient
              .from("product_variants")
              .select("id")
              .eq("id", variantIdParam)
              .eq("product_id", productId)
              .eq("tenant_id", cart.tenant_id)
              .eq("is_active", true)
              .is("deleted_at", null)
              .maybeSingle()
          : Promise.resolve({ data: null as { id: string } | null }),
        (() => {
          let q = adminClient.from("storefront_cart_items").select("id, quantity").eq("cart_id", cart.id).eq("product_id", productId);
          q = variantIdParam ? q.eq("variant_id", variantIdParam) : q.is("variant_id", null);
          return q.maybeSingle();
        })(),
      ]);

      const product = productResult.data;
      if (!product) throw new StorefrontError("Producto no encontrado.", 404);

      let variantId: string | null = null;
      if (product.has_variants) {
        if (!variantIdParam) throw new StorefrontError("Este producto tiene variantes -- elegí una primero.");
        if (!variantResult.data) throw new StorefrontError("Variante no encontrada.", 404);
        variantId = variantResult.data.id;
      }

      const existingItem = existingItemResult.data;
      if (existingItem) {
        const { error } = await adminClient.from("storefront_cart_items").update({ quantity: existingItem.quantity + quantity }).eq("id", existingItem.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await adminClient.from("storefront_cart_items").insert({ cart_id: cart.id, product_id: product.id, variant_id: variantId, quantity });
        if (error) throw new Error(error.message);
      }

      return { session_token: cart.session_token, items: await loadCartItems(adminClient, cart.id) };
    }

    case "update_cart_item": {
      const sessionToken = String(body.session_token ?? "").trim();
      const itemId = String(body.item_id ?? "").trim();
      const quantity = Number(body.quantity);
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");
      if (!itemId) throw new StorefrontError("item_id es requerido.");
      if (!Number.isFinite(quantity) || quantity <= 0) throw new StorefrontError("Cantidad inválida -- para quitar el ítem usá remove_cart_item.");

      const cart = await resolveCart(adminClient, sessionToken);
      assertCartOpen(cart);

      // Update con el filtro de pertenencia (cart_id) incluido en la misma
      // consulta, en vez de un select aparte solo para confirmar que el ítem
      // existe y es de este carrito -- el `select("id")` de la respuesta ya
      // dice si algo matcheó.
      const { data: updated, error } = await adminClient.from("storefront_cart_items").update({ quantity }).eq("id", itemId).eq("cart_id", cart.id).select("id");
      if (error) throw new Error(error.message);
      if (!updated || updated.length === 0) throw new StorefrontError("Ítem no encontrado.", 404);
      return { items: await loadCartItems(adminClient, cart.id) };
    }

    case "remove_cart_item": {
      const sessionToken = String(body.session_token ?? "").trim();
      const itemId = String(body.item_id ?? "").trim();
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");
      if (!itemId) throw new StorefrontError("item_id es requerido.");

      const cart = await resolveCart(adminClient, sessionToken);
      assertCartOpen(cart);

      const { data: removed, error } = await adminClient.from("storefront_cart_items").delete().eq("id", itemId).eq("cart_id", cart.id).select("id");
      if (error) throw new Error(error.message);
      if (!removed || removed.length === 0) throw new StorefrontError("Ítem no encontrado.", 404);
      return { items: await loadCartItems(adminClient, cart.id) };
    }

    case "request_checkout_otp": {
      const sessionToken = String(body.session_token ?? "").trim();
      const phone = String(body.phone ?? "").trim();
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");
      if (!phone) throw new StorefrontError("phone es requerido.");

      const cart = await resolveCart(adminClient, sessionToken);
      assertCartOpen(cart);

      const { count } = await adminClient
        .from("storefront_phone_verifications")
        .select("id", { count: "exact", head: true })
        .eq("tenant_id", cart.tenant_id)
        .eq("phone", phone)
        .gte("created_at", new Date(Date.now() - OTP_RATE_LIMIT_WINDOW_MINUTES * 60_000).toISOString());
      if ((count ?? 0) >= OTP_RATE_LIMIT_MAX) {
        throw new StorefrontError("Ya te mandamos varios códigos a ese número -- esperá unos minutos antes de pedir otro.", 429);
      }

      const { phoneNumberId, accessToken, template } = await resolveAuthTemplateSendContext(adminClient, cart.tenant_id);

      const code = String(cryptoRandomInt(100000, 999999));
      const { error: insertError } = await adminClient.from("storefront_phone_verifications").insert({
        tenant_id: cart.tenant_id,
        cart_id: cart.id,
        phone,
        code,
        expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
      });
      if (insertError) throw new Error(insertError.message);

      const components: Record<string, unknown>[] = [];
      if (template.variable_count > 0) components.push({ type: "body", parameters: [{ type: "text", text: code }] });
      // Las plantillas AUTHENTICATION creadas con el botón estándar de Meta
      // ("Copiar código") tienen un botón URL con un placeholder dinámico
      // ({{1}} en la URL, ver whatsapp_message_templates.buttons) -- Meta
      // exige su propio componente "button" con el mismo código como
      // parámetro, aparte del "body". Sin esto, el envío falla con
      // "(#131008) Required parameter is missing".
      if (template.buttons.some((b) => b.type === "URL")) {
        components.push({ type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: code }] });
      }
      const sendResult = await sendWhatsappTemplate(phoneNumberId, accessToken, phone, template.name, template.language, components);
      if (!sendResult.ok) throw new StorefrontError(sendResult.errorMessage ?? "No se pudo enviar el código.", 502);

      return { sent: true };
    }

    case "verify_checkout_otp": {
      const sessionToken = String(body.session_token ?? "").trim();
      const phone = String(body.phone ?? "").trim();
      const code = String(body.code ?? "").trim();
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");
      if (!phone) throw new StorefrontError("phone es requerido.");
      if (!code) throw new StorefrontError("code es requerido.");

      const cart = await resolveCart(adminClient, sessionToken);

      const { data: verification } = await adminClient
        .from("storefront_phone_verifications")
        .select("id, code, attempts")
        .eq("cart_id", cart.id)
        .eq("phone", phone)
        .is("verified_at", null)
        .gt("expires_at", new Date().toISOString())
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!verification) throw new StorefrontError("El código venció o no existe -- pedí uno nuevo.", 410);
      if (verification.attempts >= OTP_MAX_ATTEMPTS) throw new StorefrontError("Demasiados intentos -- pedí un código nuevo.", 429);

      if (verification.code !== code) {
        await adminClient.from("storefront_phone_verifications").update({ attempts: verification.attempts + 1 }).eq("id", verification.id);
        throw new StorefrontError("Código incorrecto.", 400);
      }

      await adminClient.from("storefront_phone_verifications").update({ verified_at: new Date().toISOString() }).eq("id", verification.id);

      // Recién ACÁ, con el código ya confirmado (probó ser dueño de ese
      // WhatsApp), se revela si ese teléfono ya es cliente del tenant --
      // nunca antes de este punto, para no convertir el checkout en un
      // oráculo de "este teléfono es cliente sí/no" para cualquiera que
      // solo sepa el número.
      return { verified: true, ...(await loadClientIdentity(adminClient, cart.tenant_id, phone)) };
    }

    // Se llama al recargar la página estando ya pasado el paso de OTP --
    // pedido explícito del usuario: antes, un simple refresh volvía a pedir
    // el código de cero aunque la verificación server-side (30 minutos de
    // validez, ver OTP_VERIFIED_VALID_MINUTES) siguiera vigente. Reusa esa
    // misma ventana en vez de una nueva: si ya hay un
    // storefront_phone_verifications vigente para este carrito+teléfono, no
    // hace falta un código nuevo -- solo re-arma la misma respuesta que
    // verify_checkout_otp para que el frontend pueda saltar directo al paso
    // de detalles.
    case "get_verified_identity": {
      const sessionToken = String(body.session_token ?? "").trim();
      const phone = String(body.phone ?? "").trim();
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");
      if (!phone) throw new StorefrontError("phone es requerido.");

      const cart = await resolveCart(adminClient, sessionToken);

      const { data: verification } = await adminClient
        .from("storefront_phone_verifications")
        .select("id")
        .eq("cart_id", cart.id)
        .eq("phone", phone)
        .not("verified_at", "is", null)
        .gte("verified_at", new Date(Date.now() - OTP_VERIFIED_VALID_MINUTES * 60_000).toISOString())
        .order("verified_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!verification) throw new StorefrontError("Tu verificación venció -- pedí un código nuevo.", 401);

      return { verified: true, ...(await loadClientIdentity(adminClient, cart.tenant_id, phone)) };
    }

    case "checkout": {
      const sessionToken = String(body.session_token ?? "").trim();
      const fullName = String(body.full_name ?? "").trim();
      const phone = String(body.phone ?? "").trim();
      const documentType = body.document_type ? String(body.document_type).trim() : null;
      const documentNumber = body.document_number ? String(body.document_number).trim() : null;
      const addressId = body.address_id ? String(body.address_id).trim() : "";
      const addressInput = body.address as Record<string, unknown> | undefined;
      // Envío y facturación son direcciones distintas -- pedido explícito
      // del usuario, "la facturación es de donde saco los datos para la
      // factura". Por default van a la misma (billing_same_as_shipping !==
      // false), pero el checkout puede pedir explícitamente una dirección
      // de facturación separada (guardada o nueva).
      const billingSameAsShipping = body.billing_same_as_shipping !== false;
      const billingAddressId = body.billing_address_id ? String(body.billing_address_id).trim() : "";
      const billingAddressInput = body.billing_address as Record<string, unknown> | undefined;
      // El browser es quien sabe su propio origin real (localhost en dev, el
      // dominio de producción, y se autoajusta solo si ese dominio cambia) --
      // más simple y confiable que hardcodear una URL de la tienda acá.
      // Nunca sensible ni explotable cross-usuario (ver salesOrderPayments.ts):
      // en el peor caso, alguien manipula el redirect de SU PROPIO pago.
      const redirectUrl = body.redirect_url ? String(body.redirect_url).trim() : undefined;
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");
      if (!fullName) throw new StorefrontError("full_name es requerido.");
      if (!phone) throw new StorefrontError("phone es requerido.");
      if (!addressId && !addressInput) throw new StorefrontError("Elegí una dirección de envío o cargá una nueva.");
      if (!billingSameAsShipping && !billingAddressId && !billingAddressInput) {
        throw new StorefrontError("Elegí una dirección de facturación o cargá una nueva.");
      }

      const cart = await resolveCart(adminClient, sessionToken);
      assertCartOpen(cart);

      const { data: verification } = await adminClient
        .from("storefront_phone_verifications")
        .select("id")
        .eq("cart_id", cart.id)
        .eq("phone", phone)
        .not("verified_at", "is", null)
        .gte("verified_at", new Date(Date.now() - OTP_VERIFIED_VALID_MINUTES * 60_000).toISOString())
        .limit(1)
        .maybeSingle();
      if (!verification) throw new StorefrontError("Verificá tu teléfono primero.", 403);

      const cartItems = await loadCartItemsForCheckout(adminClient, cart.id);
      if (cartItems.length === 0) throw new StorefrontError("El carrito está vacío.", 400);

      const clientId = await resolveOrCreateClient(adminClient, cart.tenant_id, phone, fullName, documentType, documentNumber);

      const shippingAddressRowId = await resolveOrderAddress(adminClient, cart.tenant_id, clientId, addressId, addressInput, fullName, phone, {
        is_shipping: true,
        is_billing: billingSameAsShipping,
      });
      const billingAddressRowId = billingSameAsShipping
        ? shippingAddressRowId
        : await resolveOrderAddress(adminClient, cart.tenant_id, clientId, billingAddressId, billingAddressInput, fullName, phone, {
            is_shipping: false,
            is_billing: true,
          });

      // Placeholder -- persistOrderItems recalcula subtotal/tax_total/total
      // reales más abajo, única fuente de verdad compartida con
      // whatsapp-ai-tools y el portal.
      const { data: order, error: orderError } = await adminClient
        .from("sales_orders")
        .insert({
          tenant_id: cart.tenant_id,
          contact_id: clientId,
          billing_address_id: billingAddressRowId,
          shipping_address_id: shippingAddressRowId,
          subtotal: 0,
          tax_total: 0,
          total: 0,
          notes: "Pedido creado desde la tienda pública.",
          sales_channel: "storefront",
        })
        .select("id, number")
        .single();
      if (orderError) throw new Error(orderError.message);

      const resolvedItems: ResolvedOrderItem[] = cartItems.map((item) => ({
        product_id: item.product_id,
        variant_id: item.variant_id,
        product_name: item.product_name,
        sku: item.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_type_code: item.tax_type_code,
        tax_rate: item.tax_rate,
      }));
      await persistOrderItems(adminClient, cart.tenant_id, order.id, resolvedItems, 0);

      const confirmResult = await confirmSalesOrder(adminClient, cart.tenant_id, clientId, order.id);
      // Address no debería bloquearse -- billing/shipping ya vienen seteados
      // arriba -- pero insufficient_stock sí es real acá (el carrito nunca
      // valida stock hasta este punto, ver comentario de más arriba en este
      // archivo) -- no dejamos el carrito a medio convertir en ningún caso.
      if (confirmResult.blocked) {
        const message = confirmResult.reason === "insufficient_stock" ? confirmResult.detail ?? "No hay stock suficiente para completar el pedido." : "No se pudo confirmar el pedido (dirección faltante).";
        throw new StorefrontError(message, 422);
      }

      await adminClient
        .from("storefront_carts")
        .update({ status: "converted", converted_order_id: order.id, converted_at: new Date().toISOString() })
        .eq("id", cart.id);

      const orderCode = formatOrderCode(confirmResult.order.number);
      const { data: client } = await adminClient.from("clients").select("credit_enabled").eq("id", clientId).maybeSingle();
      const wompiAvailable = await isTenantWompiConnected(adminClient, cart.tenant_id);
      const creditAvailable = !!client?.credit_enabled && (await isTenantCreditModuleEnabled(adminClient, cart.tenant_id));

      // El pedido ya quedó creado y confirmado arriba (y el carrito ya quedó
      // "converted") sin importar qué pasa acá abajo -- por eso, si hay más
      // de un método disponible, la resolución del pago queda para
      // "select_payment_method" (ver esa acción) en vez de intentarlo acá
      // mismo con un `payment_method` en este mismo body: este endpoint NO
      // se puede volver a llamar una segunda vez para el mismo carrito
      // (assertCartOpen ya lo rechazaría, y de paso duplicaría el pedido).
      if (wompiAvailable && creditAvailable) return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_options: ["wompi", "credito"] };
      if (creditAvailable) {
        const paid = await chargeSalesOrderToCredit(adminClient, cart.tenant_id, clientId, order.id);
        return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_method: "credito", payment_charged: true, amount: paid.amount };
      }
      if (wompiAvailable) {
        const link = await createSalesOrderPaymentLink(adminClient, cart.tenant_id, order.id, null, redirectUrl);
        return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_method: "wompi", checkout_url: link.checkoutUrl, amount: link.amount };
      }
      return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_pending: true };
    }

    // Segundo paso cuando "checkout" devolvió payment_options (más de un
    // método disponible) -- el pedido, el cliente y las direcciones YA se
    // crearon en esa primera llamada y el carrito YA quedó "converted" ahí
    // mismo. Bug real encontrado: antes, elegir un método en la pantalla de
    // "¿cómo querés pagar?" volvía a llamar a "checkout" desde cero, que
    // choca con assertCartOpen (el carrito ya no está "active") y tira
    // "Este carrito ya fue completado" -- y aunque no chocara, habría
    // intentado crear un SEGUNDO pedido duplicado con los mismos ítems. Esta
    // acción nunca crea nada: solo resuelve el pago sobre el pedido que ya
    // existe, ubicado por session_token -> storefront_carts.converted_order_id
    // (nunca por un order_id suelto en el body).
    case "select_payment_method": {
      const sessionToken = String(body.session_token ?? "").trim();
      const paymentMethod = String(body.payment_method ?? "").trim();
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");
      if (paymentMethod !== "wompi" && paymentMethod !== "credito") throw new StorefrontError("payment_method inválido.");

      const cart = await resolveCart(adminClient, sessionToken);
      const { data: cartRow } = await adminClient.from("storefront_carts").select("converted_order_id").eq("id", cart.id).maybeSingle();
      if (!cartRow?.converted_order_id) throw new StorefrontError("Este carrito todavía no generó ningún pedido.", 404);

      const { data: order } = await adminClient
        .from("sales_orders")
        .select("id, number, contact_id")
        .eq("id", cartRow.converted_order_id)
        .eq("tenant_id", cart.tenant_id)
        .maybeSingle();
      if (!order) throw new StorefrontError("Pedido no encontrado.", 404);
      const orderCode = formatOrderCode(order.number);

      if (paymentMethod === "credito") {
        const { data: client } = await adminClient.from("clients").select("credit_enabled").eq("id", order.contact_id).maybeSingle();
        const creditAvailable = !!client?.credit_enabled && (await isTenantCreditModuleEnabled(adminClient, cart.tenant_id));
        if (!creditAvailable) throw new StorefrontError("El pago a crédito no está disponible.");
        const paid = await chargeSalesOrderToCredit(adminClient, cart.tenant_id, order.contact_id, order.id);
        return { confirmed: true, order_number: order.number, order_code: orderCode, payment_method: "credito", payment_charged: true, amount: paid.amount };
      }

      const wompiAvailable = await isTenantWompiConnected(adminClient, cart.tenant_id);
      if (!wompiAvailable) throw new StorefrontError("El pago con Wompi no está disponible.");
      const redirectUrl = body.redirect_url ? String(body.redirect_url).trim() : undefined;
      const link = await createSalesOrderPaymentLink(adminClient, cart.tenant_id, order.id, null, redirectUrl);
      return { confirmed: true, order_number: order.number, order_code: orderCode, payment_method: "wompi", checkout_url: link.checkoutUrl, amount: link.amount };
    }

    // Se llama al volver del checkout externo de Wompi (ver el redirect_url
    // de arriba) -- el visitante vuelve a la MISMA página del carrito, así
    // que hace falta reconstruir el estado del pedido desde cero (recargó la
    // página entera, no quedó nada en memoria de React). Scoped por
    // session_token, igual que toda otra acción acá -- nunca por un order_id
    // suelto en la URL, para no convertir esto en una forma de consultar el
    // estado de pago de un pedido ajeno.
    case "get_order_status": {
      const sessionToken = String(body.session_token ?? "").trim();
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");

      const cart = await resolveCart(adminClient, sessionToken);
      const { data: cartRow } = await adminClient.from("storefront_carts").select("converted_order_id").eq("id", cart.id).maybeSingle();
      if (!cartRow?.converted_order_id) throw new StorefrontError("Este carrito todavía no generó ningún pedido.", 404);

      const { data: order } = await adminClient
        .from("sales_orders")
        .select("id, number, total")
        .eq("id", cartRow.converted_order_id)
        .eq("tenant_id", cart.tenant_id)
        .maybeSingle();
      if (!order) throw new StorefrontError("Pedido no encontrado.", 404);

      const { data: payments } = await adminClient.from("sales_order_payments").select("amount").eq("order_id", order.id).is("deleted_at", null);
      const totalPaid = (payments ?? []).reduce((sum: number, p: { amount: number }) => sum + Number(p.amount), 0);

      return { order_number: order.number, order_code: formatOrderCode(order.number), total: order.total, paid: totalPaid >= order.total - 0.01 };
    }

    default:
      throw new StorefrontError(`Acción desconocida: ${action}`);
  }
}

async function loadFirstImages(adminClient: SupabaseClient, productIds: string[]): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  if (productIds.length === 0) return images;
  const { data } = await adminClient
    .from("product_images")
    .select("product_id, storage_path, display_order")
    .in("product_id", productIds)
    .is("variant_id", null)
    .order("display_order", { ascending: true });
  for (const row of (data ?? []) as { product_id: string; storage_path: string }[]) {
    if (!images.has(row.product_id)) {
      images.set(row.product_id, adminClient.storage.from("product-images").getPublicUrl(row.storage_path).data.publicUrl);
    }
  }
  return images;
}

/** Una sola consulta a product_stock para toda la página de resultados --
 * separa las filas "propias" de un producto simple (variant_id null) de las
 * de cada variante, en vez de sumar todo junto por product_id (eso mezclaría
 * el stock de todos los colores/tallas de un producto con variantes, mismo
 * error que ya se evitó en confirmSalesOrder.ts). */
async function loadStock(
  adminClient: SupabaseClient,
  tenantId: string,
  productIds: string[],
): Promise<{ stockByProduct: Map<string, number>; stockByVariant: Map<string, number> }> {
  const stockByProduct = new Map<string, number>();
  const stockByVariant = new Map<string, number>();
  if (productIds.length === 0) return { stockByProduct, stockByVariant };

  const { data } = await adminClient.from("product_stock").select("product_id, variant_id, quantity").eq("tenant_id", tenantId).in("product_id", productIds);
  for (const row of (data ?? []) as { product_id: string; variant_id: string | null; quantity: number }[]) {
    if (row.variant_id) {
      stockByVariant.set(row.variant_id, (stockByVariant.get(row.variant_id) ?? 0) + row.quantity);
    } else {
      stockByProduct.set(row.product_id, (stockByProduct.get(row.product_id) ?? 0) + row.quantity);
    }
  }
  return { stockByProduct, stockByVariant };
}

/** Variantes de todos los productos-con-variantes de la página, en un solo
 * viaje -- agrupadas por product_id para que el catálogo pueda ofrecer un
 * selector rápido de variante sin tener que pedirlas de a un producto a la
 * vez (list_variants sigue existiendo aparte para el detalle). */
async function loadVariantsByProduct(
  adminClient: SupabaseClient,
  tenantId: string,
  productIds: string[],
  stockByVariant: Map<string, number>,
  productPriceById: Map<string, number>,
): Promise<Map<string, { id: string; label: string; price: number; available: number }[]>> {
  const result = new Map<string, { id: string; label: string; price: number; available: number }[]>();
  if (productIds.length === 0) return result;

  const { data } = await adminClient
    .from("product_variants")
    .select("id, product_id, retail_price, option1_value, option2_value, option3_value")
    .eq("tenant_id", tenantId)
    .in("product_id", productIds)
    .eq("is_active", true)
    .is("deleted_at", null);

  for (const v of (data ?? []) as { id: string; product_id: string; retail_price: number | null; option1_value: string | null; option2_value: string | null; option3_value: string | null }[]) {
    const list = result.get(v.product_id) ?? [];
    list.push({
      id: v.id,
      label: [v.option1_value, v.option2_value, v.option3_value].filter(Boolean).join(" / "),
      price: v.retail_price ?? productPriceById.get(v.product_id) ?? 0,
      available: stockByVariant.get(v.id) ?? 0,
    });
    result.set(v.product_id, list);
  }
  return result;
}

async function loadCartItems(adminClient: SupabaseClient, cartId: string): Promise<Record<string, unknown>[]> {
  const { data, error } = await adminClient
    .from("storefront_cart_items")
    .select("id, product_id, variant_id, quantity, product:products(name, retail_price), variant:product_variants(retail_price, option1_value, option2_value, option3_value)")
    .eq("cart_id", cartId);
  if (error) throw new Error(error.message);

  const productIds = (data ?? []).map((row: { product_id: string }) => row.product_id);
  const images = await loadFirstImages(adminClient, productIds);

  // deno-lint-ignore no-explicit-any
  return (data ?? []).map((row: any) => {
    const unitPrice = row.variant?.retail_price ?? row.product?.retail_price ?? 0;
    const variantLabel = row.variant ? [row.variant.option1_value, row.variant.option2_value, row.variant.option3_value].filter(Boolean).join(" / ") : null;
    return {
      id: row.id,
      product_id: row.product_id,
      variant_id: row.variant_id,
      name: row.product?.name ?? "",
      variant_label: variantLabel,
      quantity: row.quantity,
      unit_price: unitPrice,
      subtotal: unitPrice * row.quantity,
      image_url: images.get(row.product_id) ?? null,
    };
  });
}

async function loadCartItemsForCheckout(
  adminClient: SupabaseClient,
  cartId: string,
): Promise<
  {
    product_id: string;
    variant_id: string | null;
    product_name: string;
    sku: string | null;
    quantity: number;
    unit_price: number;
    tax_type_code: string | null;
    tax_rate: number;
  }[]
> {
  const { data, error } = await adminClient
    .from("storefront_cart_items")
    .select(
      "product_id, variant_id, quantity, product:products(name, sku, retail_price, tax_type_code, tax_rate), variant:product_variants(sku, retail_price)",
    )
    .eq("cart_id", cartId);
  if (error) throw new Error(error.message);
  // deno-lint-ignore no-explicit-any
  return (data ?? []).map((row: any) => ({
    product_id: row.product_id,
    variant_id: row.variant_id,
    product_name: row.product?.name ?? "",
    sku: row.variant?.sku ?? row.product?.sku ?? null,
    quantity: row.quantity,
    unit_price: row.variant?.retail_price ?? row.product?.retail_price ?? 0,
    // El impuesto es una clasificación del producto, nunca de la variante.
    tax_type_code: row.product?.tax_type_code ?? null,
    tax_rate: row.product?.tax_rate ?? 0,
  }));
}

/** Resuelve la dirección de envío O de facturación de un pedido -- misma
 * función para las dos, solo cambian los flags que se les ponen a una
 * dirección NUEVA (una reusada ya sabe su rol por cuál picker la eligió, no
 * hace falta tocarle los flags). Con `addressId` reutiliza una guardada,
 * verificando SIEMPRE que sea de este cliente y este tenant (nunca se confía
 * en un id que mande el visitante sin comprobar dueño primero -- si no,
 * cualquiera podría mandar el id de la dirección de otro cliente y hacer que
 * un pedido propio se facture/envíe ahí, filtrando esa dirección ajena). Sin
 * `addressId`, crea una nueva a partir de `addressInput`. */
async function resolveOrderAddress(
  adminClient: SupabaseClient,
  tenantId: string,
  clientId: string,
  addressId: string,
  addressInput: Record<string, unknown> | undefined,
  fullName: string,
  phone: string,
  newAddressFlags: { is_shipping: boolean; is_billing: boolean },
): Promise<string> {
  if (addressId) {
    const { data: ownedAddress } = await adminClient
      .from("contact_addresses")
      .select("id")
      .eq("id", addressId)
      .eq("tenant_id", tenantId)
      .eq("contact_id", clientId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!ownedAddress) throw new StorefrontError("Esa dirección no es válida.", 403);
    return ownedAddress.id;
  }

  const address = addressInput!;
  const line1 = String(address.line1 ?? "").trim();
  const city = String(address.city ?? "").trim();
  if (!line1 || !city) throw new StorefrontError("La dirección necesita al menos dirección (line1) y ciudad.");
  const { data: addressRow, error: addressError } = await adminClient
    .from("contact_addresses")
    .insert({
      tenant_id: tenantId,
      contact_id: clientId,
      is_shipping: newAddressFlags.is_shipping,
      is_billing: newAddressFlags.is_billing,
      recipient_name: fullName,
      phone,
      line1,
      line2: address.line2 ? String(address.line2).trim() : null,
      city,
      state_province: address.state_province ? String(address.state_province).trim() : null,
      postal_code: address.postal_code ? String(address.postal_code).trim() : null,
      country: address.country ? String(address.country).trim() : "Colombia",
    })
    .select("id")
    .single();
  if (addressError) throw new Error(addressError.message);
  return addressRow.id;
}

/** Precarga nombre/documento + direcciones guardadas (mismo
 * `contact_addresses` que ya usa el flujo de ventas de la IA) de un cliente
 * ya existente por teléfono -- compartido entre verify_checkout_otp (recién
 * verificado el código) y get_verified_identity (recargó la página con una
 * verificación server-side todavía vigente), las dos únicas dos formas de
 * llegar acá ya con el teléfono probado. */
async function loadClientIdentity(
  adminClient: SupabaseClient,
  tenantId: string,
  phone: string,
): Promise<{ client: { full_name: string; document_type: string | null; document_number: string | null } | null; addresses: Record<string, unknown>[] }> {
  // clients.phone quedó como SOLO el número local desde
  // 20260904000000_clients_phone_prefix_split.sql -- `phone` acá sigue
  // siendo el número completo verificado por OTP, hay que partirlo.
  const { dialCode, localNumber } = splitPhone(phone);
  const { data: existingClient } = await adminClient
    .from("clients")
    .select("id, full_name, document_type, document_number")
    .eq("tenant_id", tenantId)
    .eq("phone_prefix", dialCode)
    .eq("phone", localNumber)
    .is("deleted_at", null)
    .maybeSingle();

  if (!existingClient) return { client: null, addresses: [] };

  const { data: addressRows } = await adminClient
    .from("contact_addresses")
    .select("id, label, recipient_name, phone, line1, line2, city, state_province, postal_code, country, is_shipping, is_billing, is_default")
    .eq("tenant_id", tenantId)
    .eq("contact_id", existingClient.id)
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });

  return {
    client: { full_name: existingClient.full_name, document_type: existingClient.document_type, document_number: existingClient.document_number },
    addresses: addressRows ?? [],
  };
}

/** Resolve-or-create el `clients` por teléfono -- mismo patrón que
 * resolveOrCreateContact (whatsapp-ai-tools/index.ts), sin el paso de
 * conversationId porque acá no existe ninguna conversación de WhatsApp. Se
 * llama recién después de que checkout ya verificó el teléfono por OTP, así
 * que resolver a un cliente EXISTENTE acá es seguro -- ya probamos que quien
 * está comprando es dueño de ese número. Si ya existe y no tenía documento
 * cargado, lo completa con lo que mandó el checkout -- nunca pisa uno que ya
 * tenía (mismo criterio "no perder lo que el tenant ya cargó" que
 * whatsapp-webhook usa para el nombre). El índice único de
 * `clients(tenant_id, document_number)` puede rechazar el update/insert si
 * ese documento ya es de otro cliente -- se traduce a un mensaje claro en
 * vez de un 500 crudo. */
async function resolveOrCreateClient(
  adminClient: SupabaseClient,
  tenantId: string,
  phone: string,
  fullName: string,
  documentType: string | null,
  documentNumber: string | null,
): Promise<string> {
  const documentConflict = "Ese número de documento ya está registrado con otro cliente -- escribinos por WhatsApp si es un error.";

  // Mismo criterio que loadClientIdentity -- `phone` es el número completo
  // verificado por OTP, clients.phone/phone_prefix ya viven separados.
  const { dialCode, localNumber } = splitPhone(phone);
  const { data: existing } = await adminClient
    .from("clients")
    .select("id, document_number")
    .eq("tenant_id", tenantId)
    .eq("phone_prefix", dialCode)
    .eq("phone", localNumber)
    .is("deleted_at", null)
    .maybeSingle();
  if (existing) {
    if (documentNumber && !existing.document_number) {
      const { error } = await adminClient.from("clients").update({ document_type: documentType, document_number: documentNumber }).eq("id", existing.id);
      if (error) {
        if (error.code === "23505") throw new StorefrontError(documentConflict, 409);
        throw new Error(error.message);
      }
    }
    return existing.id;
  }

  const { data: created, error } = await adminClient
    .from("clients")
    .insert({ tenant_id: tenantId, full_name: fullName, phone_prefix: dialCode, phone: localNumber, document_type: documentType, document_number: documentNumber })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") throw new StorefrontError(documentConflict, 409);
    throw new Error(error.message);
  }
  return created.id;
}

/** Resuelve la plantilla AUTHENTICATION aprobada del tenant + la línea de
 * WhatsApp que comparte su misma business_account_id (las plantillas son por
 * WABA, no por línea) -- si falta cualquier pieza (sin plantilla aprobada,
 * sin línea activa para esa WABA, sin token), tira el mismo mensaje
 * genérico: el checkout no puede verificar teléfonos todavía, sin inventar
 * ningún fallback inseguro. */
async function resolveAuthTemplateSendContext(
  adminClient: SupabaseClient,
  tenantId: string,
): Promise<{
  phoneNumberId: string;
  accessToken: string;
  template: { name: string; language: string; variable_count: number; buttons: { type: string }[] };
}> {
  const unavailable = "Esta tienda todavía no puede verificar tu teléfono -- escribinos por WhatsApp para completar tu compra.";

  const { data: template } = await adminClient
    .from("whatsapp_message_templates")
    .select("name, language, variable_count, business_account_id, buttons")
    .eq("tenant_id", tenantId)
    .eq("category", "AUTHENTICATION")
    .eq("status", "APPROVED")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!template) throw new StorefrontError(unavailable, 409);

  const { data: line } = await adminClient
    .from("whatsapp_lines")
    .select("id, phone_number_id")
    .eq("tenant_id", tenantId)
    .eq("business_account_id", template.business_account_id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (!line) throw new StorefrontError(unavailable, 409);

  const { data: accessToken } = await adminClient.rpc("get_whatsapp_line_access_token", { p_line_id: line.id });
  if (!accessToken) throw new StorefrontError(unavailable, 409);

  return {
    phoneNumberId: line.phone_number_id,
    accessToken,
    template: { name: template.name, language: template.language, variable_count: template.variable_count, buttons: template.buttons ?? [] },
  };
}

function cryptoRandomInt(min: number, max: number): number {
  const range = max - min + 1;
  const value = crypto.getRandomValues(new Uint32Array(1))[0];
  return min + (value % range);
}

function formatOrderCode(number: number): string {
  return String(number).padStart(3, "0");
}

/** Duplicado a propósito de whatsapp-ai-tools/whatsapp-ai-respond -- mismo
 * criterio ya documentado ahí (mantener cada Edge Function desplegable por
 * separado), y la misma corrección real: lee payment_credential_secrets
 * directo, nunca la RPC payment_credential_configured_secrets (gatea con
 * is_superadmin()/auth_active_tenant_id(), que necesitan un JWT de usuario
 * real -- acá es 100% service role). */
async function isTenantWompiConnected(adminClient: SupabaseClient, tenantId: string): Promise<boolean> {
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

async function isTenantCreditModuleEnabled(adminClient: SupabaseClient, tenantId: string): Promise<boolean> {
  const { data } = await adminClient.from("tenant_enabled_modules").select("id").eq("tenant_id", tenantId).eq("module_key", "credit").maybeSingle();
  return !!data;
}
