-- Elimina las 10 tablas crm_* que quedaban -- pedido explícito del usuario
-- (2026-08-17), confirmado dos veces después de explicarle el impacto real
-- en producción, no solo modelado muerto:
--   - whatsapp-webhook deja de poder recibir mensajes (insertaba/leía
--     crm_contacts en cada mensaje entrante).
--   - Aurora (whatsapp-ai-tools): las skills "calendario" y "oportunidades"
--     quedan rotas (crm_appointments/crm_pipelines/crm_pipeline_stages/
--     crm_opportunities/crm_tasks/crm_contacts).
--   - send-appointment-reminders (Edge Function) queda rota (lee
--     crm_appointments + embed crm_contacts).
--   - Fotos de tareas (crm_attachments.task_id -> crm_tasks) dejan de
--     poder subirse/verse.
--   - Notas manuales del contacto (pestaña "Actividad", crm_notes) se
--     pierden -- nunca se migraron.
--   - Libreta de direcciones (pestaña "Direcciones", crm_contact_addresses)
--     se pierde, Y sales_orders.shipping_address_id/billing_address_id
--     (repunteadas ahí en el cutover de Órdenes) quedan sin destino.
-- Nada de esto se arregla en esta migración -- es la consecuencia
-- explícitamente aceptada del borrado.

-- 1) Triggers de espejo que escriben HACIA las tablas crm_* (dirección
-- "_to_crm") -- hay que sacarlos antes de borrar las tablas, si no la
-- próxima vez que alguien inserte/actualice en `contacts`/`pipelines`/
-- `opportunities`/`tasks` el trigger intentaría escribir en una tabla que
-- ya no existe.
drop trigger trg_mirror_contacts_to_crm_contacts on public.contacts;
drop trigger trg_mirror_pipelines_to_crm_pipelines on public.pipelines;
drop trigger trg_mirror_pipelines_delete_to_crm_pipelines on public.pipelines;
drop trigger trg_mirror_pipeline_stages_to_crm_pipeline_stages on public.pipeline_stages;
drop trigger trg_mirror_pipeline_stages_delete_to_crm_pipeline_stages on public.pipeline_stages;
drop trigger trg_mirror_opportunities_to_crm_opportunities on public.opportunities;
drop trigger trg_mirror_tasks_to_crm_tasks on public.tasks;

drop function public.mirror_contact_to_crm();
drop function public.mirror_pipeline_to_crm();
drop function public.mirror_pipeline_delete_to_crm();
drop function public.mirror_pipeline_stage_to_crm();
drop function public.mirror_pipeline_stage_delete_to_crm();
drop function public.mirror_opportunity_to_crm();
drop function public.mirror_task_to_crm();

-- 2) Triggers/funciones fuera del grupo que escriben en tablas crm_* y
-- romperían con un error duro (no solo un embed vacío) si se dejan tal
-- cual:
--   - tenants_seed_default_pipeline (dispara en cada alta de tenant nuevo,
--     inserta en crm_pipelines) -- se saca sin reemplazo porque
--     tenants_seed_default_pipeline_core ya siembra pipelines/pipeline_stages
--     en paralelo desde la Fase 3, así que un tenant nuevo sigue arrancando
--     con su pipeline poblado igual.
--   - trg_sales_orders_confirmed_opportunity (dispara al confirmar una
--     venta, movía la oportunidad vinculada a "Ganado" en crm_opportunities/
--     crm_pipeline_stages) -- se saca para que confirmar una venta no
--     empiece a fallar; se pierde el auto-movimiento a Ganado, la venta en
--     sí sigue confirmándose bien.
drop trigger tenants_seed_default_pipeline on public.tenants;
drop function public.seed_default_pipeline();

drop trigger trg_sales_orders_confirmed_opportunity on public.sales_orders;
drop function public.apply_sales_order_confirmed_opportunity_effect();

-- 3) Las tablas, en orden hijo-a-padre. CASCADE solo donde hay una FK
-- externa real (sales_orders/whatsapp_conversations) -- ahí lo único que
-- se cae es el constraint, no ninguna fila de esas tablas.
drop table public.crm_attachments;
drop table public.crm_opportunity_stage_history;
drop table public.crm_tasks;
drop table public.crm_opportunities cascade;
drop table public.crm_appointments;
drop table public.crm_notes;
drop table public.crm_contact_addresses cascade;
drop table public.crm_pipeline_stages;
drop table public.crm_pipelines;
drop table public.crm_contacts cascade;

-- 4) Funciones de espejo "hacia lo nuevo" -- su trigger ya se borró solo
-- junto con la tabla crm_* a la que estaba pegado, esto es solo prolijidad.
drop function public.mirror_contact_to_new();
drop function public.mirror_pipeline_to_new();
drop function public.mirror_pipeline_delete_to_new();
drop function public.mirror_pipeline_stage_to_new();
drop function public.mirror_pipeline_stage_delete_to_new();
drop function public.mirror_opportunity_to_new();
drop function public.mirror_task_to_new();
