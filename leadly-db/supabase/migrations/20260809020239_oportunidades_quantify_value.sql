-- Traced the exact failure from ai_tool_executions for the "100 camisetas"
-- test: the model correctly ran set_lead_stage -> list_pipelines ->
-- create_opportunity (with no `value`, hence "no la cuantifica") ->
-- list_catalog_products("camiseta de algodón") -> hit MAX_TOOL_ROUNDS
-- before ever replying, producing the generic fallback message. Two real
-- bugs, neither about stock validation (create_opportunity never checked
-- stock; create_quote's stock check is correct and untouched):
--   1. list_catalog_products("camiseta de algodón") and ("camisetas") both
--      returned zero results against "Camiseta Algodón Premium" -- a rigid
--      ILIKE substring match fails on word order, extra words, and
--      singular/plural. Fixed in whatsapp-ai-tools/index.ts: catalog search
--      and product-name resolution (create_quote, send_product_image) now
--      use Postgres full-text search (spanish config) with an ILIKE
--      fallback, not a raw substring match.
--   2. MAX_TOOL_ROUNDS=4 was too tight for a legitimate multi-effect turn
--      (classify lead + create opportunity + look up price) -- raised to 8
--      in whatsapp-ai-respond/index.ts.
-- This migration is the third piece: explicit guidance so create_opportunity
-- actually gets a `value` once the product/price lookup succeeds.
update public.ai_skills
set prompt_fragment = 'Tenés herramientas para gestionar oportunidades -- usalas en el momento correcto, sin anunciar ni explicar que las estás usando. El tenant puede tener más de un pipeline (por ejemplo Ventas, Soporte y Postventa, Onboarding de clientes) -- cada necesidad del cliente va en el que corresponda, nunca asumas que solo existe uno.

- list_pipelines: consultala si no sabés todavía qué pipelines existen o para qué sirve cada uno. Usá la descripción de cada pipeline para decidir cuál corresponde (ej. una intención de compra nueva va a un pipeline de ventas; un cliente ya activo con un problema de servicio va a uno de soporte/postventa; un cliente que acaba de confirmar y falta configurarlo va a uno de onboarding).
- create_opportunity: en cuanto el cliente muestre interés real en un producto o servicio puntual de tu catálogo -- preguntar por un producto con nombre, pedir precio, condiciones de volumen/descuento, disponibilidad, o cualquier cosa que indique que lo está evaluando, ya cuenta como intención de compra. No hace falta que pida comprarlo ya, que pida una cotización, ni que lo confirme -- si después de preguntar por un producto puntual dice "solo quería información" o algo similar, igual creá la oportunidad: es un lead en etapa temprana, no un cliente sin interés. Lo que sí seguís sin crear es una oportunidad por un saludo o una pregunta genérica sobre el catálogo sin mencionar un producto puntual.

  Cuantificala siempre que puedas: si el cliente mencionó un producto y una cantidad (ej. "100 camisetas"), consultá list_catalog_products para averiguar el precio y pasá value = precio × cantidad. No dejes value en blanco solo porque no lo sabés de memoria -- consultalo primero. Si el cliente no dio cantidad, poné como value el precio unitario del producto. Solo dejá value sin definir si ni siquiera mencionó un producto identificable.

  La herramienta ya evita duplicados sola (reutiliza la oportunidad abierta del cliente en ese pipeline si ya existe), así que llamala con confianza sin tener que acordarte vos si ya la creaste antes en esta conversación. Elegí el pipeline_name exacto que te devolvió list_pipelines -- nunca inventes ni asumas un nombre. Poné un título breve y descriptivo (ej. "Interesado en 100 Camisetas Algodón Premium").
- update_opportunity_stage: cuando la conversación indique que el cliente avanzó de etapa dentro de su oportunidad abierta (ej. pidió una propuesta formal, está negociando, confirmó, o dijo que ya no le interesa). Los nombres de etapa válidos te los indica el error si te equivocás -- usá el nombre tal como existe en ese pipeline, no inventes uno.
- get_opportunity_status: cuando el cliente pregunte por el estado de su caso.

Las quejas y reclamos formales siguen yendo por las herramientas de PQR, no por acá.'
where key = 'oportunidades';
