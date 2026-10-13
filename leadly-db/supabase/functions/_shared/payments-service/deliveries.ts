// Entrega de avisos a los proyectos (outbox). HTTPS, sin redirecciones,
// timeout 10 s, anti-SSRF, firma HMAC del sobre (spec §4).
import { checkCallbackDestination, DestinationError } from "./ssrf.ts";
import { callRpc, logEvent, redact } from "./errors.ts";
import { sha256Hex, signEnvelope } from "./hmac.ts";
import { DELIVERY_TIMEOUT_MS } from "./types.ts";
import type { ClaimedDelivery, Deps } from "./types.ts";

export interface DeliveryOutcome {
  delivery_id: string;
  ok: boolean;
  http_status: number;
  error: string | null;
}

async function complete(deps: Deps, id: string, status: number, durationMs: number, error: string | null, sentSha256: string | null) {
  try {
    await callRpc(deps.rpc, "payments_complete_delivery", {
      p_delivery_id: id,
      p_http_status: status,
      p_duration_ms: durationMs,
      p_error: error,
      p_sent_sha256: sentSha256,
    });
  } catch (e) {
    logEvent({ level: "error", event: "complete_delivery_failed", delivery_id: id, message: e instanceof Error ? e.message : String(e) });
  }
}

export async function deliverOne(deps: Deps, item: ClaimedDelivery): Promise<DeliveryOutcome> {
  const started = deps.now();
  // sha256 de los bytes realmente enviados (null si nunca se llegó a enviar).
  let sentSha: string | null = null;
  const finish = async (ok: boolean, status: number, error: string | null): Promise<DeliveryOutcome> => {
    await complete(deps, item.delivery_id, status, Math.max(0, deps.now() - started), error, sentSha);
    logEvent({ level: ok ? "info" : "warn", event: "delivery", delivery_id: item.delivery_id, attempt: item.attempt, http_status: status, error });
    return { delivery_id: item.delivery_id, ok, http_status: status, error };
  };

  try {
    await checkCallbackDestination(item.url, deps.resolveDns);
  } catch (e) {
    const reason = e instanceof DestinationError ? e.reason : "invalid_url";
    return finish(false, 0, `destination_not_allowed:${reason}`);
  }

  if (!item.signing_secret_name) return finish(false, 0, "signing_secret_unavailable");
  let secret: string | null = null;
  try {
    secret = await callRpc<string | null>(deps.rpc, "payments_read_secret", { p_name: item.signing_secret_name });
  } catch {
    secret = null;
  }
  if (!secret) return finish(false, 0, "signing_secret_unavailable");

  const rawBody = JSON.stringify(item.body);
  const t = Math.floor(deps.now() / 1000);
  const signature = await signEnvelope(secret, rawBody, t);
  sentSha = await sha256Hex(rawBody);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeouts?.deliveryMs ?? DELIVERY_TIMEOUT_MS);
  try {
    const res = await deps.fetch(item.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Payments-Signature": signature,
        "Payments-Event-Id": String((item.body as { id?: unknown }).id ?? ""),
        "Payments-Delivery-Attempt": String(item.attempt),
        "User-Agent": "Lexy-Payments/1",
      },
      body: rawBody,
      redirect: "manual",
      signal: ctl.signal,
    });
    try {
      await res.body?.cancel();
    } catch { /* ignorar */ }
    if (res.status >= 200 && res.status < 300) return finish(true, res.status, null);
    if (res.status >= 300 && res.status < 400) return finish(false, res.status, "redirect_not_followed");
    return finish(false, res.status, `http_${res.status}`);
  } catch (e) {
    const aborted = e instanceof DOMException && e.name === "AbortError";
    return finish(false, 0, aborted ? "timeout" : `network_error:${redact(e instanceof Error ? e.name : "error", 60)}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Reclama entregas vencidas y las intenta (en lotes paralelos pequeños). */
export async function dispatchDue(deps: Deps, limit: number): Promise<{ claimed: number; delivered: number; failed: number }> {
  const items = (await callRpc<ClaimedDelivery[] | null>(deps.rpc, "payments_claim_deliveries", { p_limit: limit })) ?? [];
  let delivered = 0;
  let failed = 0;
  const BATCH = 5;
  for (let i = 0; i < items.length; i += BATCH) {
    const outcomes = await Promise.all(items.slice(i, i + BATCH).map((it) => deliverOne(deps, it)));
    for (const o of outcomes) o.ok ? delivered++ : failed++;
  }
  return { claimed: items.length, delivered, failed };
}
