-- Lets a tenant classify what a conversation is about ("tipo de
-- conversación") -- separate from `mode` (who's answering) and `status`
-- (open/closed). Nullable: existing/new conversations start unclassified,
-- the agent sets it from the chat header once they know.
alter table public.whatsapp_conversations
  add column category text check (category in ('venta', 'soporte', 'consulta', 'reclamo', 'otro'));
