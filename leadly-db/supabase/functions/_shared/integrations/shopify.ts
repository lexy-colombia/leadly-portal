// Minimal Shopify Admin GraphQL client -- ported from tania-functions'
// ShopifyRepositoryImpl (~/Desktop/SEERI/tania-functions/internal/repositories/shopify_repository.go),
// trimmed to the read-only queries the `shopify` ai_skill needs: search
// products, find a customer by phone, search orders. No mutations (order/
// draft-order creation stays out of scope, see CLAUDE.md).
const API_VERSION = "2026-04";

// Shopify store names only ever contain letters/digits/hyphens. Forcing the
// Admin API host to always end in `.myshopify.com` (Shopify's own domain --
// the Admin API isn't reachable at a custom domain anyway) closes off the
// tenant-configurable `config.shop` field as an SSRF vector: no value a
// tenant types in can make the resulting fetch() target anything other than
// a real Shopify store.
const SHOPIFY_STORE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,60}[a-z0-9]$|^[a-z0-9]$/i;

export function resolveShopifyDomain(rawShop: string): string {
  const trimmed = rawShop.trim().toLowerCase();
  const bare = trimmed
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.myshopify\.com$/, "");
  if (!SHOPIFY_STORE_NAME_RE.test(bare)) {
    throw new Error("La tienda Shopify configurada no es válida.");
  }
  return `${bare}.myshopify.com`;
}

function escapeGraphQLString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Shopify's search mini-language treats `:` as a field filter and `()` as
// grouping -- stripping those (plus the bare boolean keywords) means a
// customer-supplied refinement term can only ever narrow the mandatory
// `customer_id:` scope below, never redefine which field is being matched
// or OR its way past it.
function sanitizeOrderSearchTerm(input: string): string {
  return input
    .replace(/[:()"]/g, " ")
    .replace(/\b(AND|OR|NOT)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Orders search's `customer_id:` filter wants the legacy numeric id, not
// the GraphQL global id (`gid://shopify/Customer/123`) `searchCustomerByPhone`
// returns.
function numericIdFromGid(gid: string): string {
  const match = gid.match(/(\d+)$/);
  if (!match) throw new Error("Shopify customer id inválido");
  return match[1];
}

// WhatsApp numbers arrive as digits-only; Shopify stores phone as E.164 --
// try a few normalized variants, same trick as ShopifyPhoneSearchVariants.
function phoneSearchVariants(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const variants = new Set<string>();
  variants.add(trimmed);
  const digits = trimmed.replace(/\D/g, "");
  if (digits) {
    variants.add(digits);
    variants.add(`+${digits}`);
    if (digits.length >= 10) variants.add(digits.slice(-10));
  }
  return [...variants];
}

async function graphql(
  shop: string,
  accessToken: string,
  query: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://${shop}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "X-Shopify-Access-Token": accessToken, "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    throw new Error(`Shopify API error (HTTP ${res.status})`);
  }
  const body = await res.json();
  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${body.errors.map((e: { message: string }) => e.message).join("; ")}`);
  }
  return body.data as Record<string, unknown>;
}

export async function searchProducts(shop: string, accessToken: string, query: string, first = 10): Promise<unknown[]> {
  const data = await graphql(
    shop,
    accessToken,
    `query {
      products(first: ${first}, query: "${escapeGraphQLString(query)}") {
        edges {
          node {
            id
            title
            status
            handle
            productType
            vendor
            totalInventory
            variants(first: 1) {
              edges { node { id price compareAtPrice sku inventoryQuantity } }
            }
          }
        }
      }
    }`,
  );
  const products = data.products as { edges: Array<{ node: unknown }> };
  return products.edges.map((e) => e.node);
}

export async function searchCustomerByPhone(shop: string, accessToken: string, phone: string): Promise<unknown | null> {
  for (const variant of phoneSearchVariants(phone)) {
    const data = await graphql(
      shop,
      accessToken,
      `query {
        customers(first: 1, query: "phone:${escapeGraphQLString(variant)}") {
          edges {
            node {
              id
              firstName
              lastName
              displayName
              email
              phone
              defaultAddress { address1 city country }
            }
          }
        }
      }`,
    );
    const customers = data.customers as { edges: Array<{ node: unknown }> };
    if (customers.edges.length > 0) return customers.edges[0].node;
  }
  return null;
}

// Always scoped to a single customer -- `customerGid` must come from
// searchCustomerByPhone for *this* WhatsApp contact, never from the AI's
// free-text query, so one contact can never see another customer's orders.
export async function searchOrders(
  shop: string,
  accessToken: string,
  customerGid: string,
  extraQuery: string,
  first = 10,
): Promise<unknown[]> {
  const customerId = numericIdFromGid(customerGid);
  const refinement = sanitizeOrderSearchTerm(extraQuery);
  const scopedQuery = refinement ? `customer_id:${customerId} ${refinement}` : `customer_id:${customerId}`;
  const data = await graphql(
    shop,
    accessToken,
    `query {
      orders(first: ${first}, query: "${escapeGraphQLString(scopedQuery)}") {
        edges {
          node {
            id
            name
            createdAt
            displayFinancialStatus
            displayFulfillmentStatus
            totalPriceSet { shopMoney { amount currencyCode } }
          }
        }
      }
    }`,
  );
  const orders = data.orders as { edges: Array<{ node: unknown }> };
  return orders.edges.map((e) => e.node);
}
