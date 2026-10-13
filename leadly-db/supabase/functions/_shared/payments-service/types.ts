// payments-service -- tipos compartidos. Contrato normativo:
// progress/payments_interface_spec.md (§2 funciones SQL, §3 rutas, §4 sobre).

export interface RpcError {
  code?: string;
  message: string;
}

/** Subconjunto de supabase-js que usa el servicio. Se inyecta para poder
 * probarlo sin red ni base de datos. */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

export type SecretGetter = (secretName: string) => Promise<string | null>;

/** Ambiente de un link / de una API key. */
export type PayEnvironment = "sandbox" | "production";

export interface PlatformCredential {
  mode: PayEnvironment;
  getSecret: SecretGetter;
}

export interface AuthenticatedClient {
  id: string;
  name: string;
  status: string;
  callback_url: string | null;
  signing_secret_name: string | null;
  /** Ambiente que declara la propia API key (segmento test|live). */
  environment: PayEnvironment;
}

/** Destino legacy de un evento de Wompi (tablas de `public` anteriores al
 * servicio nuevo): factura de plataforma o link de cobro de un tenant. */
export interface LegacyTarget {
  origin: "invoice" | "order_link";
  /** payment_invoices.id | sales_order_payment_links.id */
  id: string;
  wompiLinkId: string;
  /** Tenant cuyo Wompi cobra (null = credencial de plataforma). */
  merchantTenantId: string | null;
  /** Estado nativo de la fila (PENDING/PAID/... | pending/paid/...). */
  status: string;
  /** Monto esperado en centavos que se le pidio a Wompi al crear el cobro (null = no almacenado). */
  expectedCents: number | null;
  currency: string | null;
  /** Fila marcada como borrada (soft-delete): no es pagable en silencio. */
  deleted: boolean;
  /** Transaccion que ya acredito este destino (si ya esta pagado). */
  appliedTransactionId: string | null;
}

/** Acceso a las tablas legacy de `public`. Se inyecta (real: legacyStore.ts). */
export interface LegacyStore {
  /** null = ninguna fila; "ambiguous" = mas de una fila para el mismo checkout (no se paga nada). */
  find(wompiLinkId: string): Promise<LegacyTarget | "ambiguous" | null>;
  /** Credencial Wompi del merchant (null = plataforma). null si no hay una activa o no se pudo leer. */
  getCredential(merchantTenantId: string | null): Promise<PlatformCredential | null>;
  /** ¿Esta transaccion ya acredito OTRO destino legacy (otra factura / otro pago de pedido)? */
  transactionUsedElsewhere(transactionId: string, target: LegacyTarget): Promise<boolean>;
  /** Aplica el pago/intento reutilizando applyWebhookEvent / applySalesOrderPaymentWebhookEvent. */
  apply(target: LegacyTarget, tx: Record<string, unknown>): Promise<{ handled: boolean }>;
  /** Estado publico (solo lectura) de una fila legacy por SU id propio
   * (payment_invoices.id | sales_order_payment_links.id). null = no existe o esta borrada. */
  publicStatus(id: string): Promise<{ status: PublicLinkStatus; updatedAt: string | null } | null>;
}

/** Estados que expone la ruta publica de retorno (/v1/public/payment-links/{id}/status). */
export type PublicLinkStatus = "paid" | "pending" | "expired" | "cancelled" | "voided" | "error" | "unknown";

export interface Deps {
  rpc: RpcClient;
  fetch: typeof fetch;
  /** ms desde epoch */
  now: () => number;
  /** Credencial de plataforma de Wompi (resolveCredential(null,'wompi')); null si no hay una activa. */
  getPlatformCredential: () => Promise<PlatformCredential | null>;
  /** Origenes legacy (public.payment_invoices / public.sales_order_payment_links). */
  legacy: LegacyStore;
  /** Valida el JWT del caller y que profiles.role = 'superadmin'. Lanza ApiError 401/403. */
  verifyAdmin: (authHeader: string | null) => Promise<{ userId: string }>;
  /** Resolución DNS opcional (Deno.resolveDns). Si no existe, el anti-SSRF solo mira literales. */
  resolveDns?: (hostname: string) => Promise<string[]>;
  env: {
    /** https://<ref>.supabase.co */
    supabaseUrl: string;
    /** Secreto compartido del cron (CRON_REMINDER_SECRET) */
    cronSecret: string | null;
    /** Base publica del SPA (PUBLIC_APP_URL) para el redirect por defecto de los links.
     * Opcional: sin valor se usa el dominio por defecto de _shared/publicAppUrl.ts. */
    appBaseUrl?: string | null;
  };
  /** Timeouts (ms) -- inyectables para pruebas. */
  timeouts?: { deliveryMs?: number; wompiMs?: number; verifyMs?: number };
}

export interface ClaimedDelivery {
  delivery_id: string;
  url: string;
  client_id: string;
  signing_secret_name: string | null;
  body: Record<string, unknown>;
  attempt: number;
}

export const DELIVERY_TIMEOUT_MS = 10_000;
export const WOMPI_TIMEOUT_MS = 15_000;
export const VERIFY_TIMEOUT_MS = 8_000;
