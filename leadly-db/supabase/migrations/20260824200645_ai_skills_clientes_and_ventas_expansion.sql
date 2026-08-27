-- Nueva habilidad "clientes" + ampliación de "ventas" (despachos,
-- devoluciones, agregar ítems a una cotización ya creada) y "catalogo"
-- (filtro por marca). Tool implementations viven en _shared/aiTools.ts +
-- whatsapp-ai-tools/index.ts, no acá -- esta migración solo registra el
-- catálogo de habilidades.
--
-- list_contact_addresses/save_contact_address se mueven de la habilidad
-- "ventas" a la nueva "clientes" (gestión del cliente, no del pedido en
-- sí) -- backfill abajo para que ningún asistente en producción pierda esa
-- capacidad de un día para otro solo porque "ventas" ya no la trae.

insert into public.ai_skills (key, name, description, prompt_fragment) values
(
  'clientes',
  'Gestión de clientes',
  'El asistente puede confirmar y completar los datos del contacto actual (nombre, documento de identidad, direcciones de envío/facturación) -- necesario para poder facturar y despachar sus pedidos.',
  'Herramientas de gestión de clientes disponibles -- endpoints estructurados, sin lógica de negocio propia. Todas operan siempre sobre el contacto de esta conversación, nunca sobre otro (no existe ninguna herramienta para buscar o consultar el registro de otra persona):

- get_client_profile(): sin parámetros. Devuelve { full_name, document_type, document_number, email } del contacto actual (cualquier campo puede venir en null si todavía no está cargado).
- update_client_profile({ full_name?, document_type?, document_number?, email? }): actualiza solo los campos que recibe, del contacto actual. document_type es uno de: NIT, CC, CE, RUC, RFC, PASAPORTE, OTRO.
- list_contact_addresses(): sin parámetros. Devuelve las direcciones guardadas del contacto.
- save_contact_address({ address_id?, ...campos de dirección, apply_as_shipping?, apply_as_billing? }): crea o actualiza una dirección, y opcionalmente la aplica al pedido más reciente.'
);

update public.ai_skills set
  description = 'El asistente corre el flujo completo de venta: arma una cotización con productos del catálogo (y puede seguir agregándole ítems mientras siga abierta), la confirma como venta, consulta el estado del despacho, y gestiona una devolución si el pedido ya fue entregado.',
  prompt_fragment = 'Herramientas de ventas disponibles -- endpoints estructurados, sin lógica de negocio propia. Cotización y venta son la misma entidad, identificada por su estado:
- create_quote({ items: [{ product_name, quantity }], notes? }): crea el pedido en estado "cotizacion" y reserva el stock pedido. Devuelve { order_number, order_code, total, items }.
- add_item_to_quote({ items: [{ product_name, quantity }] }): agrega producto(s) a la cotización más reciente, solo si sigue en estado "cotizacion". Devuelve el pedido actualizado, mismo shape que create_quote.
- get_quote_status(): sin parámetros. Devuelve el pedido más reciente del contacto: { found, order_number, order_code, status, total, total_paid, balance_due, notes, items }.
- add_order_comment({ comment }): agrega un comentario de texto libre al pedido más reciente.
- confirm_quote(): sin parámetros. Pasa el pedido de "cotizacion" a "confirmada" y descuenta el inventario real; puede fallar por stock insuficiente.
- cancel_quote(): sin parámetros. Cancela un pedido todavía en "cotizacion" y libera el stock reservado.
- complete_sale(): sin parámetros. Marca el pedido confirmado como "entregada".
- get_dispatch_status(): sin parámetros. Devuelve { found, status, carrier_name, tracking_number, tracking_url, history } del despacho más reciente del pedido más reciente. found=false si todavía no se generó ningún despacho.
- create_return({ items: [{ product_name, quantity }], reason }): solicita una devolución sobre el pedido más reciente -- solo funciona si ese pedido está "entregada", y solo sobre productos que efectivamente están en ese pedido. Nunca fijes vos el reembolso o la nota crédito, eso lo decide un agente humano.
- get_return_status(): sin parámetros. Devuelve el estado de la devolución más reciente del contacto, y su resolución si ya se resolvió.

Direcciones de envío/facturación NO están acá -- son parte de la habilidad de Gestión de clientes (list_contact_addresses/save_contact_address).'
where key = 'ventas';

update public.ai_skills set
  prompt_fragment = 'Herramientas de catálogo disponibles en esta habilidad -- son endpoints estructurados, sin lógica de negocio propia; cómo y cuándo usarlos lo define el prompt de cada negocio:

- list_catalog_categories(): sin parámetros. Devuelve hasta 5 categorías del tenant: { name, description }.
- list_catalog_products({ search?, category?, brand? }): todos los parámetros opcionales. Devuelve { products: [{ name, sku, price, category, description }] }. `search` es texto libre sobre el nombre del producto. `category`/`brand` filtran por el nombre exacto de una categoría/marca. Si se pasa `category` o `brand` sin `search`, el resultado viene priorizado internamente por el motor -- no lo reordenes. No incluye stock/disponibilidad, eso se resuelve en la habilidad de Ventas.
- send_product_image({ product_name }): envía la foto principal del producto cuyo `name` coincide exactamente con el que recibe.'
where key = 'catalogo';

-- Backfill: todo asistente con "ventas" activo hoy recibe "clientes"
-- activo también, para no perder de un día para otro la gestión de
-- direcciones que hasta ahora vivía bajo "ventas".
insert into public.ai_assistant_skills (ai_assistant_id, skill_key)
select ai_assistant_id, 'clientes'
from public.ai_assistant_skills
where skill_key = 'ventas'
on conflict (ai_assistant_id, skill_key) do nothing;
