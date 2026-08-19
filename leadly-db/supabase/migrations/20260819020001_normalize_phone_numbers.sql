-- Bug real en producción (2026-08-19): un cliente escribió un "hola" de
-- vuelta a una conversación que había arrancado una campaña, y en vez de
-- seguir en el mismo hilo, whatsapp-webhook creó una conversación nueva
-- (y, aparte, un cliente duplicado). Causa raíz: Meta siempre manda
-- `message.from` sin "+" (solo dígitos), pero nada en la app fuerza ese
-- mismo formato al capturar un teléfono a mano (formulario de Clientes,
-- destinatario manual de una campaña, seeds de QA) -- un "+573..." guardado
-- así nunca hace match con el "573..." que llega por el webhook, ni en el
-- lookup de `clients` ni en el upsert de `whatsapp_conversations`
-- (onConflict whatsapp_line_id+contact_phone), así que cada uno termina en
-- una fila separada.
--
-- Fix: normalizar a solo-dígitos por trigger en las tres tablas donde un
-- teléfono se compara contra el de Meta -- refuerzo a nivel de DB en vez de
-- confiar en que cada formulario nuevo (o cada script de seed) se acuerde de
-- limpiarlo él mismo, que es exactamente lo que falló acá.
create or replace function public.normalize_phone_column()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  col text := TG_ARGV[0];
  raw text;
  cleaned text;
begin
  raw := (to_jsonb(new) ->> col);
  if raw is null then
    return new;
  end if;
  cleaned := regexp_replace(raw, '\D', '', 'g');
  if cleaned is distinct from raw then
    new := jsonb_populate_record(new, jsonb_build_object(col, cleaned));
  end if;
  return new;
end;
$$;

revoke execute on function public.normalize_phone_column() from public, anon, authenticated;

create trigger trg_clients_normalize_phone
  before insert or update of phone on public.clients
  for each row execute function public.normalize_phone_column('phone');

create trigger trg_whatsapp_conversations_normalize_phone
  before insert or update of contact_phone on public.whatsapp_conversations
  for each row execute function public.normalize_phone_column('contact_phone');

create trigger trg_campaign_recipients_normalize_phone
  before insert or update of contact_phone on public.campaign_recipients
  for each row execute function public.normalize_phone_column('contact_phone');

-- Backfill seguro: solo los 20 clientes demo de QA (+5732077000xx) que no
-- tienen ninguna conversación de WhatsApp asociada todavía -- cero riesgo de
-- colisión. El caso real con conversación e historial (Karol Quesada,
-- +573173176941 vs 573173176941 duplicado) se deja aparte a propósito: fusionar
-- ese requiere mover mensajes entre conversaciones y decidir qué fila de
-- cliente sobrevive, no es un simple UPDATE de formato.
update public.clients
set phone = regexp_replace(phone, '\D', '', 'g')
where phone ~ '[^0-9]'
  and not exists (
    select 1 from public.whatsapp_conversations wc where wc.contact_id = clients.id
  );
