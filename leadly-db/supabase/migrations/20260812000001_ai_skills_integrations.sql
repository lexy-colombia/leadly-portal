-- Turns the mapped-but-unwired Wompi/HubSpot/Shopify integrations
-- (20260811000013/14/15 -- credential storage only, no Edge Function calls
-- their API yet) into real AI tool-calling habilidades, ported from the
-- sibling tania-functions project's executor patterns (Go microservice under
-- ~/Desktop/SEERI/tania-functions) but scoped down to what a WhatsApp
-- lead-qualification assistant actually needs -- not a 1:1 port of its full
-- HubSpot/Shopify executor surface (meetings, tickets, B2B catalogs, draft
-- orders, etc. stay out, see CLAUDE.md).
--
-- hubspot_contact_id lets hubspot_create_deal resolve "this contact's
-- already-synced HubSpot id" server-side, same principle as
-- resolveLatestPqr/resolveLatestOrder in whatsapp-ai-tools: the model is
-- never trusted to remember an id it saw in an earlier turn.
alter table public.crm_contacts add column hubspot_contact_id text;

insert into public.ai_skills (key, name, description, prompt_fragment) values
(
  'wompi',
  'Cobro con Wompi',
  'El asistente puede generar un enlace de pago de Wompi para cobrarle directamente al cliente de esta conversación (la cuenta de Wompi del propio tenant, no la de Leadly).',
  'Tenés disponible generate_payment_link para generar un enlace de pago real de Wompi y compartirlo con el cliente -- úsala cuando el cliente ya confirmó que quiere pagar y sabés el monto exacto a cobrar (por ejemplo, después de confirmar una cotización si el flujo de ventas está disponible, o ante cualquier cobro puntual que el negocio te pida hacer). Nunca inventes un monto: si no lo sabés con certeza, preguntale al cliente o resolvelo primero con otra herramienta. Si la herramienta falla porque el tenant no tiene Wompi conectado, avisale al cliente con naturalidad que un agente se va a encargar del cobro, sin mencionar detalles técnicos.'
),
(
  'hubspot',
  'Sincronización con HubSpot',
  'El asistente registra al contacto y, cuando corresponde, un negocio (deal) en la cuenta de HubSpot del propio tenant.',
  'Tenés herramientas para reflejar este lead en HubSpot -- úsalas sin anunciarlo, solo actuá y seguí la conversación con naturalidad.

- hubspot_sync_contact: llamala en cuanto tengas al menos el email del cliente, para crear o actualizar su contacto en HubSpot (el teléfono ya lo toma del contacto de esta conversación, no hace falta pedirlo de nuevo).
- hubspot_list_deal_pipelines: consultala antes de crear un negocio si no sabés todavía qué pipelines/etapas existen en la cuenta de HubSpot del tenant -- nunca inventes un nombre de pipeline o etapa.
- hubspot_create_deal: creá un negocio cuando haya una oportunidad de venta concreta y el contacto ya esté sincronizado (hubspot_sync_contact primero). Si todavía no tenés el email del cliente, pedíselo antes de intentar esto.

Si alguna de estas herramientas falla porque el tenant no tiene HubSpot conectado, seguí la conversación con naturalidad sin mencionarlo -- no es un dato que el cliente necesite saber.'
),
(
  'shopify',
  'Consulta de Shopify',
  'El asistente puede buscar productos, clientes y pedidos en la tienda Shopify del propio tenant, en modo solo lectura.',
  'Tenés herramientas de solo lectura sobre la tienda Shopify del tenant -- úsalas para responder con datos reales, nunca inventes precios, stock ni estados de pedido.

- shopify_search_products: cuando el cliente pregunte por un producto puntual y el catálogo real del negocio viva en Shopify (no en el catálogo propio de Leadly).
- shopify_search_customer_by_phone: para ver si el cliente de esta conversación ya tiene perfil en la tienda (no hace falta pedirle el teléfono, ya lo tenés).
- shopify_search_orders: cuando el cliente pregunte por el estado de un pedido hecho en la tienda Shopify.

Estas herramientas no crean ni modifican nada en Shopify -- si el cliente quiere comprar, seguí el flujo de ventas propio del negocio en vez de intentar generar un pedido acá. Si alguna falla porque el tenant no tiene Shopify conectado, seguí la conversación con naturalidad sin mencionarlo.'
);
