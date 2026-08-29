-- Pedido explícito del usuario (2026-08-27): "leads" es redundante con
-- "oportunidades" -- un contacto puede tener varias oportunidades abiertas
-- a la vez, así que una sola "etapa" plana a nivel de cliente (clients.stage)
-- no tiene sentido como concepto de negocio ("no hay lead sin oportunidad").
-- La tool set_lead_stage y su skill "leads" ya se eliminaron del código
-- (_shared/aiTools.ts, whatsapp-ai-tools/index.ts) -- esta migración limpia
-- el lado de la base: primero las asignaciones (FK on delete restrict impide
-- borrar la fila de ai_skills mientras existan), después la fila de ai_skills,
-- y por último la columna misma. El check constraint de la columna se cae
-- solo con el DROP COLUMN.
delete from public.ai_assistant_skills where skill_key = 'leads';
delete from public.ai_skills where key = 'leads';

alter table public.clients drop column stage;
