# Auditoría técnica — 2026-08-17

> Generado tras el cutover `crm_*` → esquema sin prefijo (`clients`/`opportunities`/`tasks`/`sales_orders`/`contact_addresses`) y el drop de las 10 tablas `crm_*` restantes (`20260817020001_drop_remaining_crm_tables.sql`). CLAUDE.md documenta la decisión y el motivo; este archivo es el checklist operativo para arreglar las consecuencias, no re-litigar la decisión. Se actualiza a medida que se cierra cada ítem — no es un snapshot congelado como CLAUDE.md.

## 🔴 Roto en producción ahora mismo

Prioridad por impacto real (un tenant con conversaciones activas ya lo sufre):

- [x] **Direcciones de cliente + envío/facturación en Ventas** — `leadly-app/src/lib/api/addresses.ts` apuntaba a `crm_contact_addresses` (dropeada); `leadly-app/src/lib/api/orders.ts` embebía `crm_contact_addresses` y `crm_opportunities` (ambas dropeadas) en el `SELECT` de `sales_orders`, lo que rompía **todo** `listOrders`/`getOrder`, no solo el campo de dirección. `sales_orders.opportunity_id`/`shipping_address_id`/`billing_address_id` se quedaron sin constraint de FK tras el `cascade` del drop. **Arreglado 2026-08-17**: FKs repunteadas a `opportunities`/`contact_addresses` (migración `20260817190000`), `addresses.ts`/`orders.ts` repunteados, tipo `CrmContactAddress` renombrado a `ContactAddress`. Direcciones **anteriores al 17-08 se perdieron** (la tabla vieja se dropeó sin migrar datos, documentado en el propio SQL) — la libreta queda vacía y se reconstruye desde ahora en adelante.
- [x] **`whatsapp-ai-tools` (Edge Function) — arreglado 2026-08-17**: repunteadas todas las skills activas (`calendario`, `oportunidades`, `leads`, `catalogo`, `ventas`, `hubspot`, `shopify`) a `appointments`/`opportunities`/`pipelines`/`pipeline_stages`/`clients`/`products`/`product_categories`/`product_images`/`sales_orders`/`sales_order_items`/`sales_order_payments`/`sales_order_comments`/`contact_addresses`. `products` ya no tiene `stock_quantity`/`reserved_stock` propios (vive en `product_stock` por bodega) — se agregó `getStockTotals()`, misma agregación cliente-side que `listStockTotalsByTenant` del frontend, usada en `list_catalog_products` (ranking por categoría) y `confirm_quote` (chequeo de stock). Desplegado (`supabase functions deploy whatsapp-ai-tools --no-verify-jwt`), smoke test 403 (auth check, arranca sin errores de import/sintaxis). **Las 6 tools de la skill `pqr`** (`create_pqr`, `create_note`, `add_pqr_update`, `update_pqr_status`, `get_pqr_status`, `send_attachment`) **se dejaron intocadas a propósito**: `pqr` ya no existe en el catálogo `ai_skills` (se borró el 17-08 junto con el resto de PQR), así que `isToolAllowed` nunca puede habilitarlas para ningún asistente — es código muerto, no un bug vivo, y tocar código de IA relacionado con PQR sin que se pida explícitamente ya generó fricción una vez en esta misma sesión. Efecto colateral real: `create_note` (que la IA anote algo en el historial del cliente) viaja en la misma skill `pqr` y quedó inalcanzable también — es una decisión de producto pendiente (¿la nota de IA merece su propia skill?), no algo que se resolvió acá.
- [x] **Calendario / Citas — arreglado 2026-08-17**: `appointments` (sin prefijo) no existía — a diferencia de `notes`/`contact_addresses`, este módulo nunca tuvo una "fase 0" paralela antes del drop. Se creó de cero (migración `20260817203435`), 1:1 contra el shape de `crm_appointments`, con `contact_id` apuntando a `clients`. `appointments.ts`, `Calendar.tsx` y compañía repunteados; tipo `CrmAppointment` renombrado a `Appointment`.
- [x] **`send-appointment-reminders` (Edge Function) — arreglado 2026-08-17**: repunteado a `appointments`/`clients`, desplegado, smoke test 403.
- [x] **Adjuntos — arreglado 2026-08-17**: solo la mitad de `attachments.ts` seguía rota (`uploadTaskAttachment`/`listAttachmentsForTask` apuntaban a `crm_attachments`, dropeada); los adjuntos de comentarios de venta ya habían sido repunteados a `attachments` (sin prefijo) en el cutover del 08-16. La tabla `attachments` en producción ya solo tiene `task_id`/`sales_order_comment_id` (sin las columnas de PQR) — se confirmó contra el esquema real antes de tocar código. Repunteadas ambas funciones a `attachments`, eliminado el tipo `CrmAttachment` (duplicado muerto de `Attachment`, que ya cubría ambos casos). El bucket de Storage `crm-attachments` no se tocó — es independiente de la tabla y sigue existiendo igual.
- [x] **Notas manuales de cliente — arreglado 2026-08-17**: se decidió reconstruir en vez de dejarlo perdido. `listNotes`/`createNote` (`contacts.ts`) repunteados de `crm_notes` (dropeada) a `notes` (sin prefijo, ya existía con el mismo shape desde el core schema del 15-08, nunca tuvo cutover). Tipo `CrmNote` renombrado a `Note`. Notas anteriores al 17-08 siguen perdidas (no había manera de recuperarlas, la tabla vieja ya no existe), pero la pestaña vuelve a guardar desde ahora.
- [x] **FKs huérfanas / integridad referencial perdida** — verificado en vivo el 17-08: `whatsapp_conversations.contact_id` **ya tiene** su constraint hacia `clients(id)` (quedó repunteada durante el cutover de `contacts`→`clients`, el rename de tabla la arrastró por OID). No hacía falta ningún arreglo acá, la nota original de la auditoría estaba desactualizada apenas se escribió.

## 🟢 Robusto (verificado, sin huecos conocidos)

- Multi-tenancy, Auth, RLS (base de Fase 0).
- WhatsApp core (webhook, Inbox, envío manual, toggle IA/humano) — ya repuntado a `clients`.
- Clientes (ex Contactos), Catálogo/Productos — cutover completo.
- Pipeline/Oportunidades, Tareas — migrados y espejados correctamente.
- Inventario Fase 1 (bodegas + kardex) — backend real; UI plegada dentro de Configuración, no como módulo propio.
- Refactor Atomic Design del frontend — completo, `tsc`/`build` limpios.
- Feature-gating por tenant (`tenant_enabled_modules`).

## 🟡 A medias por diseño (no por accidente, no bloquea nada)

- Despachos, Facturas, Cartera/crédito — sin ninguna migración todavía (Fases 2-4 del ERP, orden ya definido en CLAUDE.md).
- Exponer el ERP a Aurora (IA) — deliberadamente pospuesto a Fase 5.
- Campañas — bloqueada a propósito, sin backend.
- Kanban de Oportunidades — checklist con 2 ítems pendientes (widget de tareas en Dashboard, sacar "Tareas" del nav).
- Restos de naming cosmético (`ContactoDetalleContent`, claves i18n `contacts.order.status.*`, componente `ContactDrawer.tsx`, variables locales `contacts`/`setContacts` dentro de varios drawers) — no rompen nada, deuda cosmética. **`lib/api/contacts.ts` → `lib/api/clients.ts` ya renombrado (2026-08-17)**: `listContacts→listClients`, `getContact→getClient`, `createContact→createClient`, `updateContact→updateClient`, `deleteContact→deleteClient`, tipo `ContactStage→ClientStage`, 8 archivos consumidores actualizados. `tsc`/`build` limpios.
- Auto-movimiento de oportunidad a "Ganado" al confirmar una venta — el trigger se quitó junto con el drop de `crm_*` (`trg_sales_orders_confirmed_opportunity`) y no se repuso. La venta se sigue confirmando bien, solo se perdió el efecto automático sobre el pipeline.

## Otros arreglos hechos fuera del checklist original

- [x] **Rutas en español** (`/app/clientes`, `/app/ventas`, `/app/oportunidades`, etc.) — traducidas a inglés en `App.tsx`, `modules.ts` y todos los `Link`/`navigate()` hardcodeados (18 archivos). Los 3 redirects de compatibilidad hacia URLs viejas (`empresas`, `catalogo`, `inventario`) se dejaron con su segmento en español a propósito — existen solo para atrapar bookmarks viejos, ya apuntan a los destinos nuevos en inglés. `tsc`/`build` limpios.

## Estado: checklist de 🔴 Roto en producción cerrado (2026-08-17)

Todo lo listado arriba bajo "Roto en producción ahora mismo" está arreglado, desplegado y verificado (`tsc`/`build` limpios en frontend; smoke test 403 en ambas Edge Functions redeployadas). Pendiente real que sigue abierto, no por bug sino por decisión de producto:

- ¿La skill `pqr` (o al menos `create_note`, la nota libre de la IA) merece resucitar como algo nuevo, o queda descartada para siempre? Hoy es código muerto e inalcanzable, no roto.
- Auto-movimiento de oportunidad a "Ganado" al confirmar una venta por WhatsApp (el trigger se quitó el 17-08 y no se repuso) — ver sección 🟡 arriba.
- El resto de la deuda cosmética de naming (`ContactoDetalleContent`, `ContactDrawer.tsx`, i18n `contacts.order.status.*`) — no bloquea nada.
