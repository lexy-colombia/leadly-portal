# payments-api — guía para proyectos (receptor del aviso de pago)

Servicio de links de pago Wompi de Lexy Colombia. Un proyecto (Leadly, Bedly, Lexy Legal…) crea links con su API key y recibe un **aviso firmado** (webhook) cuando Wompi informa una transacción de ese link.

## 1. Crear un link
`POST {base}/v1/payment-links` con `Authorization: Bearer lxy_pay_<test|live>_...` e `Idempotency-Key` (1–128 `[A-Za-z0-9._:-]`). Body: `amount_in_cents` (entero ≥ 1), `currency: "COP"`, `name`, `description`, `external_reference`, y opcionales `redirect_url` (https), `expires_at` (ISO con zona), `metadata`, `taxes`. Respuesta `201` (o `200` si es un replay con la misma clave y el mismo cuerpo). Un fallo del proveedor deja el link en `error`: reintenta con **otra** Idempotency-Key.

## 2. Verificar la firma del aviso
Cada aviso es `POST <tu callback_url>` (HTTPS, sin redirecciones, timeout 10 s) con:

```
Payments-Signature: t=<unix>,v1=<hex(HMAC-SHA256(signing_secret, t + "." + rawBody))>
Payments-Event-Id: <id del evento>
Payments-Delivery-Attempt: <n>
```

1. Calcula el HMAC sobre los **bytes crudos** del cuerpo (antes de parsear), con el `signing_secret` que recibiste una sola vez al registrar el proyecto.
2. Compara en tiempo constante con `v1`. Rechaza si no coincide.
3. Rechaza si `t` difiere de tu reloj en más de 5 minutos (anti-replay).
4. Responde `2xx` rápido. Cualquier otro código (o timeout) reintenta: 1 min, 5 min, 30 min, 2 h, 6 h, 24 h; al 7.º intento queda `failed`.

## 3. Deduplicar
La entrega es *at-least-once*: el mismo aviso puede llegar más de una vez. **Deduplica por `Payments-Event-Id`** (= `id` del cuerpo) y, además, por `external_reference` antes de entregar el servicio.

## 4. Sobre
```
{ "id": "<event id>", "type": "payment_link.transaction", "created_at": "<iso>",
  "payment_link": { "id", "external_reference", "status", "amount_in_cents", "currency", "metadata" },
  "transaction": { "id", "status", "amount_in_cents", "currency" },
  "classification": "processed|duplicate_payment|amount_mismatch|...",
  "wompi": { <evento de Wompi tal como llegó> } }
```

`classification`:
- `processed`: evento válido y verificado. **No implica pago**: mira también `transaction.status` y `payment_link.status`.
- `duplicate_payment`: una **segunda** transacción aprobada sobre un link ya pagado. Dinero cobrado dos veces: candidato a reembolso. No entregues nada.
- `amount_mismatch`: monto o moneda no coinciden con el link. No es un pago válido.
- Otras (`unverified`, `verification_mismatch`, `transaction_conflict`, `invalid_signature`) no se entregan al proyecto: quedan en la bandeja del servicio para revisión.

`payment_link.status`: `pending`, `paid`, `voided` (la transacción pagada fue anulada/devuelta), `expired`, `cancelled`, `error`.

## 5. Cuándo entregar el servicio
**Solo** si se cumplen las tres a la vez:

- `classification === "processed"`, **y**
- `payment_link.status === "paid"`, **y**
- `transaction.status === "APPROVED"`.

Si recibes un aviso con `payment_link.status === "voided"` (VOIDED de la transacción pagada), revierte/ cancela lo entregado según tu negocio. DECLINED/ERROR/PENDING no son pagos: no entregues.

## 6. Consultar el estado
`GET {base}/v1/payment-links/{id}` o `GET {base}/v1/payment-links?external_reference=...` devuelve el link y `last_event`. Úsalo si perdiste un aviso.

## 7. Operación (no es parte del contrato del proyecto)
- Despliegue: `supabase functions deploy payments-api --project-ref kkdtrkfcnyvuefazndnj --no-verify-jwt`.
- Receptor de Wompi: `POST {base}/v1/events/wompi` (URL de eventos de la cuenta de plataforma). Toda APPROVED de un link propio se confirma contra `GET /transactions/{id}` de Wompi; si Wompi no responde, el servicio contesta `503` para que Wompi reintente.

## 6. URL de eventos de Wompi (receptor único)
`POST {base}/v1/events/wompi` es el **único** receptor de eventos de Wompi de la plataforma (payment-webhook-wompi se retiró). La URL de eventos de **cada** cuenta de Wompi en uso (la de plataforma y la de cada tenant con Wompi propio) debe apuntar aquí. Cada evento se resuelve, en este orden, contra: (1) links de este servicio, (2) `payment_invoices` (Lexy cobrando a un tenant; credencial de plataforma o del `merchant_tenant_id`), (3) `sales_order_payment_links` (un tenant cobrando a su cliente; credencial del tenant). Un evento de ninguno queda como `unknown_link` (200). Un llamante sin firma válida recibe siempre `401 invalid_signature`, exista o no el link.

## 7. Monto esperado de los cobros legacy (fuente de verdad)
Para facturas de plataforma el monto esperado es `payment_invoices.amount_cents`/`currency`; para links de cobro de un tenant es `sales_order_payment_links.amount` × 100 / `currency`. Es lo que se le pidió cobrar a Wompi al crear el link, **no** el saldo actual del pedido (que cambia con cada pago). Si el pedido cambia después de generar el link, el pago se acredita por lo que Wompi cobró y el pedido puede quedar con saldo residual o sobrepago. **Recomendación de producto (pendiente, no implementada):** anular los links `pending` de un pedido cuando sus ítems o su total cambian.

## 8. Defensas anti-llenado del receptor
Un evento sin `signature.checksum` hex de 64 caracteres se descarta antes de cualquier consulta o descifrado; todo evento sin firma válida guarda solo un resumen mínimo acotado (campos recortados a 128 caracteres); y las filas `invalid_signature`/`malformed` se limitan a 10 por minuto por link y 300 por minuto en total (superado el tope no se inserta fila y la respuesta 401 es la misma, con log `warn`). Un evento válido nunca se ve afectado.

## 9. Retorno del pagador (página pública de resultado)
Cuando el link se crea **sin** `redirect_url`, Wompi devuelve el navegador del pagador a `${PUBLIC_APP_URL}/pago/resultado?link=<id del link>` (por defecto `https://leadly.lexycolombia.com`; un `redirect_url` explícito del proyecto **siempre** gana). La misma regla aplica a los cobros de plataforma (`payment_invoices`) y a los links de un tenant a su cliente (`sales_order_payment_links`).

La página del SPA consulta `GET {base}/v1/public/payment-links/{id}/status` (sin autenticación, CORS abierto solo para `GET`/`OPTIONS`, `Cache-Control: no-store`) y recibe **exactamente**:
```
{ "status": "paid|pending|expired|cancelled|voided|error|unknown",
  "last_attempt": "APPROVED|DECLINED|VOIDED|ERROR|null",
  "updated_at": "<iso>|null" }
```
Sin montos, referencias, nombres, correos, ids de proveedor ni tenant. Un id inexistente o mal formado responde `200` con `{"status":"unknown","last_attempt":null,"updated_at":null}`. **Esa página nunca decide si un pago fue aprobado**: el estado sale del webhook ya procesado; los parámetros que Wompi agrega a la URL (p. ej. `?id=`) se ignoran. Un proyecto sigue entregando el servicio solo según la sección 5 (aviso firmado).
