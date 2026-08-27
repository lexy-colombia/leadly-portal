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
import { chargeSalesOrderToCredit, createSalesOrderPaymentLink } from "../_shared/payments/salesOrderPayments.ts";
import { sendWhatsappTemplate } from "../_shared/whatsapp.ts";

const CATALOG_SEARCH_LIMIT = 120;
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

      let categoryProductIds: string[] | null = null;
      if (categoryIds.length > 0) {
        const { data: links } = await adminClient.from("product_category_links").select("product_id").eq("tenant_id", tenant.id).in("category_id", categoryIds);
        categoryProductIds = [...new Set((links ?? []).map((l: { product_id: string }) => l.product_id))];
        if (categoryProductIds.length === 0) return { products: [] };
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

      let query = adminClient
        .from("products")
        .select(columns)
        .eq("tenant_id", tenant.id)
        .eq("is_active", true)
        .eq("is_visible_in_catalog", true)
        .is("deleted_at", null)
        .limit(CATALOG_SEARCH_LIMIT);
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
          .limit(CATALOG_SEARCH_LIMIT);
        fallbackQuery = applySort(fallbackQuery);
        if (categoryProductIds) fallbackQuery = fallbackQuery.in("id", categoryProductIds);
        if (brandId) fallbackQuery = fallbackQuery.eq("brand_id", brandId);
        const fallback = await fallbackQuery;
        if (fallback.error) throw new Error(fallback.error.message);
        data = fallback.data;
      }

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
      return { products };
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

      // A diferencia de las demás acciones, acá un session_token que ya no
      // resuelve a ningún carrito (el visitante volvió con un localStorage
      // viejo de un carrito que se completó o se limpió del lado del
      // servidor) NO es un error -- desde su perspectiva solo quiere agregar
      // el producto, así que se le arma un carrito nuevo en silencio en vez
      // de mostrarle "este carrito no existe".
      let cart: { id: string; tenant_id: string; status: string };
      const sessionToken = body.session_token ? String(body.session_token).trim() : "";
      let existingCart: { id: string; tenant_id: string; status: string } | null = null;
      if (sessionToken) {
        const { data } = await adminClient.from("storefront_carts").select("id, tenant_id, status").eq("session_token", sessionToken).maybeSingle();
        existingCart = data ?? null;
      }

      if (existingCart && existingCart.status === "active") {
        cart = existingCart;
      } else {
        const slug = String(body.slug ?? "").trim();
        if (!slug) throw new StorefrontError("slug es requerido para iniciar un carrito nuevo.");
        const tenant = await resolveStorefront(adminClient, slug);
        const { data: created, error } = await adminClient
          .from("storefront_carts")
          .insert({ tenant_id: tenant.id })
          .select("id, tenant_id, status, session_token")
          .single();
        if (error) throw new Error(error.message);
        cart = created;
      }

      const { data: product } = await adminClient
        .from("products")
        .select("id, has_variants, retail_price")
        .eq("id", productId)
        .eq("tenant_id", cart.tenant_id)
        .eq("is_active", true)
        .eq("is_visible_in_catalog", true)
        .is("deleted_at", null)
        .maybeSingle();
      if (!product) throw new StorefrontError("Producto no encontrado.", 404);

      let variantId: string | null = null;
      if (product.has_variants) {
        if (!variantIdParam) throw new StorefrontError("Este producto tiene variantes -- elegí una primero.");
        const { data: variant } = await adminClient
          .from("product_variants")
          .select("id")
          .eq("id", variantIdParam)
          .eq("product_id", product.id)
          .eq("tenant_id", cart.tenant_id)
          .eq("is_active", true)
          .is("deleted_at", null)
          .maybeSingle();
        if (!variant) throw new StorefrontError("Variante no encontrada.", 404);
        variantId = variant.id;
      }

      let existingQuery = adminClient.from("storefront_cart_items").select("id, quantity").eq("cart_id", cart.id).eq("product_id", product.id);
      existingQuery = variantId ? existingQuery.eq("variant_id", variantId) : existingQuery.is("variant_id", null);
      const { data: existingItem } = await existingQuery.maybeSingle();

      if (existingItem) {
        const { error } = await adminClient.from("storefront_cart_items").update({ quantity: existingItem.quantity + quantity }).eq("id", existingItem.id);
        if (error) throw new Error(error.message);
      } else {
        const { error } = await adminClient.from("storefront_cart_items").insert({ cart_id: cart.id, product_id: product.id, variant_id: variantId, quantity });
        if (error) throw new Error(error.message);
      }

      const { data: freshCart } = await adminClient.from("storefront_carts").select("session_token").eq("id", cart.id).single();
      return { session_token: freshCart!.session_token, items: await loadCartItems(adminClient, cart.id) };
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

      const { data: item } = await adminClient.from("storefront_cart_items").select("id").eq("id", itemId).eq("cart_id", cart.id).maybeSingle();
      if (!item) throw new StorefrontError("Ítem no encontrado.", 404);

      const { error } = await adminClient.from("storefront_cart_items").update({ quantity }).eq("id", item.id);
      if (error) throw new Error(error.message);
      return { items: await loadCartItems(adminClient, cart.id) };
    }

    case "remove_cart_item": {
      const sessionToken = String(body.session_token ?? "").trim();
      const itemId = String(body.item_id ?? "").trim();
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");
      if (!itemId) throw new StorefrontError("item_id es requerido.");

      const cart = await resolveCart(adminClient, sessionToken);
      assertCartOpen(cart);

      const { error } = await adminClient.from("storefront_cart_items").delete().eq("id", itemId).eq("cart_id", cart.id);
      if (error) throw new Error(error.message);
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
      return { verified: true };
    }

    case "checkout": {
      const sessionToken = String(body.session_token ?? "").trim();
      const fullName = String(body.full_name ?? "").trim();
      const phone = String(body.phone ?? "").trim();
      const address = body.address as Record<string, unknown> | undefined;
      if (!sessionToken) throw new StorefrontError("session_token es requerido.");
      if (!fullName) throw new StorefrontError("full_name es requerido.");
      if (!phone) throw new StorefrontError("phone es requerido.");
      if (!address) throw new StorefrontError("address es requerido.");
      const line1 = String(address.line1 ?? "").trim();
      const city = String(address.city ?? "").trim();
      if (!line1 || !city) throw new StorefrontError("La dirección necesita al menos dirección (line1) y ciudad.");

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

      const clientId = await resolveOrCreateClient(adminClient, cart.tenant_id, phone, fullName);

      const { data: addressRow, error: addressError } = await adminClient
        .from("contact_addresses")
        .insert({
          tenant_id: cart.tenant_id,
          contact_id: clientId,
          is_billing: true,
          is_shipping: true,
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

      const subtotal = cartItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
      const { data: order, error: orderError } = await adminClient
        .from("sales_orders")
        .insert({
          tenant_id: cart.tenant_id,
          contact_id: clientId,
          billing_address_id: addressRow.id,
          shipping_address_id: addressRow.id,
          subtotal,
          total: subtotal,
          notes: "Pedido creado desde la tienda pública.",
        })
        .select("id, number")
        .single();
      if (orderError) throw new Error(orderError.message);

      const itemRows = cartItems.map((item, index) => ({
        tenant_id: cart.tenant_id,
        order_id: order.id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        product_name: item.product_name,
        sku: item.sku,
        quantity: item.quantity,
        unit_price: item.unit_price,
        subtotal: item.quantity * item.unit_price,
        display_order: index,
      }));
      const { error: itemsError } = await adminClient.from("sales_order_items").insert(itemRows);
      if (itemsError) throw new Error(itemsError.message);

      const confirmResult = await confirmSalesOrder(adminClient, cart.tenant_id, clientId, order.id);
      // No debería bloquearse -- billing/shipping ya vienen seteados arriba
      // -- pero si algo raro pasa, no dejamos el carrito a medio convertir.
      if (confirmResult.blocked) throw new StorefrontError("No se pudo confirmar el pedido (dirección faltante).", 422);

      await adminClient
        .from("storefront_carts")
        .update({ status: "converted", converted_order_id: order.id, converted_at: new Date().toISOString() })
        .eq("id", cart.id);

      const orderCode = formatOrderCode(confirmResult.order.number);
      const { data: client } = await adminClient.from("clients").select("credit_enabled").eq("id", clientId).maybeSingle();
      const wompiAvailable = await isTenantWompiConnected(adminClient, cart.tenant_id);
      const creditAvailable = !!client?.credit_enabled && (await isTenantCreditModuleEnabled(adminClient, cart.tenant_id));

      const requestedMethod = body.payment_method ? String(body.payment_method) : null;
      if (requestedMethod && requestedMethod !== "wompi" && requestedMethod !== "credito") throw new StorefrontError("payment_method inválido.");

      if (!requestedMethod) {
        if (wompiAvailable && creditAvailable) return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_options: ["wompi", "credito"] };
        if (creditAvailable) {
          const paid = await chargeSalesOrderToCredit(adminClient, cart.tenant_id, clientId, order.id);
          return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_method: "credito", payment_charged: true, amount: paid.amount };
        }
        if (wompiAvailable) {
          const link = await createSalesOrderPaymentLink(adminClient, cart.tenant_id, order.id, null);
          return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_method: "wompi", checkout_url: link.checkoutUrl, amount: link.amount };
        }
        return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_pending: true };
      }

      if (requestedMethod === "credito") {
        if (!creditAvailable) throw new StorefrontError("El pago a crédito no está disponible.");
        const paid = await chargeSalesOrderToCredit(adminClient, cart.tenant_id, clientId, order.id);
        return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_method: "credito", payment_charged: true, amount: paid.amount };
      }

      if (!wompiAvailable) throw new StorefrontError("El pago con Wompi no está disponible.");
      const link = await createSalesOrderPaymentLink(adminClient, cart.tenant_id, order.id, null);
      return { confirmed: true, order_number: confirmResult.order.number, order_code: orderCode, payment_method: "wompi", checkout_url: link.checkoutUrl, amount: link.amount };
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
): Promise<{ product_id: string; variant_id: string | null; product_name: string; sku: string | null; quantity: number; unit_price: number }[]> {
  const { data, error } = await adminClient
    .from("storefront_cart_items")
    .select("product_id, variant_id, quantity, product:products(name, sku, retail_price), variant:product_variants(sku, retail_price)")
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
  }));
}

/** Resolve-or-create el `clients` por teléfono -- mismo patrón que
 * resolveOrCreateContact (whatsapp-ai-tools/index.ts), sin el paso de
 * conversationId porque acá no existe ninguna conversación de WhatsApp. Se
 * llama recién después de que checkout ya verificó el teléfono por OTP, así
 * que resolver a un cliente EXISTENTE acá es seguro -- ya probamos que quien
 * está comprando es dueño de ese número. */
async function resolveOrCreateClient(adminClient: SupabaseClient, tenantId: string, phone: string, fullName: string): Promise<string> {
  const { data: existing } = await adminClient.from("clients").select("id").eq("tenant_id", tenantId).eq("phone", phone).is("deleted_at", null).maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await adminClient.from("clients").insert({ tenant_id: tenantId, full_name: fullName, phone }).select("id").single();
  if (error) throw new Error(error.message);
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
): Promise<{ phoneNumberId: string; accessToken: string; template: { name: string; language: string; variable_count: number } }> {
  const unavailable = "Esta tienda todavía no puede verificar tu teléfono -- escribinos por WhatsApp para completar tu compra.";

  const { data: template } = await adminClient
    .from("whatsapp_message_templates")
    .select("name, language, variable_count, business_account_id")
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

  return { phoneNumberId: line.phone_number_id, accessToken, template: { name: template.name, language: template.language, variable_count: template.variable_count } };
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
  return secrets.has("private_key") && secrets.has("integrity_key");
}

async function isTenantCreditModuleEnabled(adminClient: SupabaseClient, tenantId: string): Promise<boolean> {
  const { data } = await adminClient.from("tenant_enabled_modules").select("id").eq("tenant_id", tenantId).eq("module_key", "credit").maybeSingle();
  return !!data;
}
