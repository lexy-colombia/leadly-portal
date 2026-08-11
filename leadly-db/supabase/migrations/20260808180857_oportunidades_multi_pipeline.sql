-- Lets the "oportunidades" skill route a case to whichever pipeline fits
-- (a tenant can now have more than one -- Ventas, Soporte y Postventa,
-- Onboarding, etc., see the demo pipelines created for Tenant QA Uno) instead
-- of always landing in a single hardcoded default pipeline. Pairs with the
-- new list_pipelines tool and create_opportunity's now-required
-- pipeline_name parameter in _shared/aiTools.ts.
update public.ai_skills
set
  description = 'El asistente identifica qué pipeline corresponde (Ventas, Soporte y Postventa, Onboarding, u otros que el tenant tenga) y crea/mueve oportunidades ahí a medida que la conversación avanza.',
  prompt_fragment = 'Tenés herramientas para gestionar oportunidades -- usalas en el momento correcto, sin anunciar ni explicar que las estás usando. El tenant puede tener más de un pipeline (por ejemplo Ventas, Soporte y Postventa, Onboarding de clientes) -- cada necesidad del cliente va en el que corresponda, nunca asumas que solo existe uno.

- list_pipelines: consultala si no sabés todavía qué pipelines existen o para qué sirve cada uno. Usá la descripción de cada pipeline para decidir cuál corresponde (ej. una intención de compra nueva va a un pipeline de ventas; un cliente ya activo con un problema de servicio va a uno de soporte/postventa; un cliente que acaba de confirmar y falta configurarlo va a uno de onboarding).
- create_opportunity: cuando la conversación muestre una necesidad concreta y todavía no exista una oportunidad abierta para este cliente en ese pipeline. Elegí el pipeline_name exacto que te devolvió list_pipelines -- nunca inventes ni asumas un nombre. Poné un título breve y descriptivo (ej. "Interesado en plan Pro").
- update_opportunity_stage: cuando la conversación indique que el cliente avanzó de etapa dentro de su oportunidad abierta (ej. pidió una propuesta formal, está negociando, confirmó, o dijo que ya no le interesa). Los nombres de etapa válidos te los indica el error si te equivocás -- usá el nombre tal como existe en ese pipeline, no inventes uno.
- get_opportunity_status: cuando el cliente pregunte por el estado de su caso.

No crees una oportunidad por cada mensaje -- solo cuando haya una necesidad real y todavía no exista una abierta para este cliente en el pipeline que corresponde. Las quejas y reclamos formales siguen yendo por las herramientas de PQR, no por acá.'
where key = 'oportunidades';
