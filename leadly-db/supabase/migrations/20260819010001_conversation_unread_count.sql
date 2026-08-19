-- Badge de "mensajes nuevos sin leer" en el Inbox (solo relevante en modo
-- humano -- en modo ia la IA ya está respondiendo, no hace falta que un
-- agente se ponga al día). Contador mantenido por trigger, mismo patrón
-- exacto que bump_conversation_last_message_at/
-- bump_conversation_last_inbound_message_at (20260818204612/204621): un
-- UPDATE simple sobre whatsapp_conversations en cada insert de
-- whatsapp_messages, no una función SQL con lock.
--
-- Solo cuenta mensajes entrantes mientras la conversación YA estaba en modo
-- humano en el momento del insert -- si está en modo ia, la IA los está
-- atendiendo en tiempo real, no se acumulan como "pendientes de leer" (si
-- después un agente toma la conversación, arranca en 0, no con el historial
-- que la IA ya respondió).
alter table public.whatsapp_conversations add column unread_count integer not null default 0 check (unread_count >= 0);

create or replace function public.bump_conversation_unread_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.direction = 'inbound' then
    update public.whatsapp_conversations
      set unread_count = unread_count + 1
      where id = new.conversation_id and mode = 'humano';
  end if;
  return new;
end;
$$;

revoke execute on function public.bump_conversation_unread_count() from public, anon, authenticated;

create trigger trg_whatsapp_messages_bump_unread_count
  after insert on public.whatsapp_messages
  for each row execute function public.bump_conversation_unread_count();
