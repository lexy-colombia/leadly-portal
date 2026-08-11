-- Two new "Habilidades" (see 20260806000001_ai_skills.sql for the pattern):
-- catalogo (buscar productos y enviar su foto) y ventas (crear/consultar/
-- confirmar/cancelar cotizaciones -- cotización y venta son la misma
-- entidad crm_orders, solo cambia el status, ver
-- 20260808000003_crm_orders.sql y 20260809000001_order_stock_effects.sql
-- para el manejo de stock). Tool implementations viven en _shared/aiTools.ts
-- + whatsapp-ai-tools/index.ts, no acá -- esta migración solo registra el
-- catálogo. Sin backfill en ai_assistant_skills a propósito, mismo criterio
-- que las habilidades anteriores.
insert into public.ai_skills (key, name, description, prompt_fragment) values
(
  'catalogo',
  'Catálogo de productos',
  'El asistente puede buscar productos del catálogo del tenant (nombre, precio, disponibilidad) y enviar su foto por WhatsApp.',
  'Tenés herramientas para consultar el catálogo de productos del tenant -- usalas en el momento correcto, sin anunciar ni explicar que las estás usando.

- list_catalog_products: cuando el cliente pregunte qué productos hay, pida precios, o mencione algo que necesitás confirmar que existe antes de ofrecerlo. Podés buscar por nombre y/o categoría.
- send_product_image: cuando el cliente pida ver una foto de un producto, o cuando mostrarla ayude a cerrar la venta. Usá el nombre exacto que te devolvió list_catalog_products.

Nunca inventes un producto, precio o disponibilidad que no te haya devuelto list_catalog_products.'
),
(
  'ventas',
  'Cotizaciones y ventas',
  'El asistente puede armar una cotización con productos del catálogo, confirmarla como venta, o cancelarla si el cliente ya no la quiere.',
  'Tenés herramientas para armar cotizaciones y ventas con productos del catálogo -- usalas en el momento correcto, sin anunciar ni explicar que las estás usando. Cotización y venta son la misma entidad: crearla la deja como "cotización" (reserva el stock pedido sin descontarlo todavía); confirmarla la convierte en venta real y ahí sí se descuenta el inventario.

- create_quote: cuando el cliente confirme qué productos y cantidades quiere. Si no sabés el nombre exacto de un producto o su precio, consultá list_catalog_products primero (habilidad de Catálogo) -- nunca inventes un producto, precio o cantidad. Si el stock no alcanza, la herramienta te lo va a decir -- avisale al cliente en vez de insistir.
- get_quote_status: cuando el cliente pregunte por el estado de su pedido o cotización.
- confirm_quote: solo cuando el cliente confirme explícitamente que quiere seguir adelante con la compra de su cotización más reciente.
- cancel_quote: solo cuando el cliente pida explícitamente cancelar su cotización más reciente (nunca una venta ya confirmada) -- libera el stock que tenía reservado.

No crees una cotización nueva si el cliente ya tiene una abierta para el mismo pedido -- preguntale si quiere modificar la existente o confirmarla.'
);
