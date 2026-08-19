-- Campañas de WhatsApp (envío masivo con Excel + programación) -- Fase 2 de
-- "iniciar conversaciones", ver CLAUDE.md. Reusa toda la infraestructura de
-- plantillas de la Fase 1 (whatsapp_message_templates, sendWhatsappTemplate):
-- una campaña es esa misma lógica de envío llamada N veces según un horario,
-- no un sistema nuevo de mensajería.

create table public.campaigns (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  name varchar(150) not null,
  whatsapp_line_id uuid not null references public.whatsapp_lines(id) on delete restrict,
  template_id uuid not null references public.whatsapp_message_templates(id) on delete restrict,
  -- Lo que la IA debe tener en mente una vez que el contacto responde --
  -- ver whatsapp-ai-respond, bloque CAMPAIGN_TOPIC_CONTEXT.
  topic text,
  scheduled_at timestamptz not null,
  status varchar(20) not null default 'draft'
    check (status in ('draft', 'scheduled', 'sending', 'completed', 'canceled', 'failed')),
  -- Denormalizados para la barra de progreso sin tener que contar
  -- campaign_recipients en cada render de la lista.
  total_recipients integer not null default 0 check (total_recipients >= 0),
  sent_count integer not null default 0 check (sent_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  created_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_name_not_blank check (btrim(name) <> '')
);
comment on table public.campaigns is 'Envío masivo programado de una plantilla de WhatsApp a una lista de contactos subida por Excel. run-campaigns (cron cada minuto) procesa las que están scheduled y ya llegó su hora.';

create index idx_campaigns_tenant_id on public.campaigns(tenant_id) where deleted_at is null;
create index idx_campaigns_due on public.campaigns(scheduled_at) where status = 'scheduled';

create trigger trg_campaigns_updated_at before update on public.campaigns
  for each row execute function public.set_updated_at();

alter table public.campaigns enable row level security;

create policy campaigns_select on public.campaigns
  for select using ((tenant_id = public.auth_active_tenant_id() or public.is_superadmin()) and deleted_at is null);

create policy campaigns_insert on public.campaigns
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy campaigns_update on public.campaigns
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.campaigns from anon;
grant select, insert, update on public.campaigns to authenticated;

-- Una fila por contacto subido en el Excel. tenant_id se denormaliza acá
-- (en vez de resolverlo siempre vía join a campaigns) para que la RLS sea
-- barata, mismo criterio ya usado en whatsapp_conversations.
create table public.campaign_recipients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  contact_phone varchar(30) not null,
  contact_name varchar(150),
  -- Array de strings, mismo orden y longitud que whatsapp_message_templates.variable_count.
  variables jsonb not null default '[]'::jsonb,
  status varchar(20) not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  error_message text,
  whatsapp_message_id uuid references public.whatsapp_messages(id) on delete set null,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  constraint campaign_recipients_phone_not_blank check (btrim(contact_phone) <> '')
);
comment on table public.campaign_recipients is 'Cola de destinatarios de una campaña -- run-campaigns toma hasta 20 en status pending por tick (ritmo autoimpuesto ~20/min) hasta vaciarla.';

create index idx_campaign_recipients_pending on public.campaign_recipients(campaign_id, status);

create or replace function public.check_campaign_recipient_tenant_matches_campaign()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  campaign_tenant_id uuid;
begin
  select tenant_id into campaign_tenant_id from public.campaigns where id = new.campaign_id;
  if campaign_tenant_id is null then
    raise exception 'campaign_id % does not exist', new.campaign_id;
  end if;
  if new.tenant_id is distinct from campaign_tenant_id then
    raise exception 'tenant_id must match the tenant_id of campaign_id';
  end if;
  return new;
end;
$$;

revoke execute on function public.check_campaign_recipient_tenant_matches_campaign() from public;

create trigger trg_campaign_recipients_tenant_check
  before insert or update of tenant_id, campaign_id on public.campaign_recipients
  for each row execute function public.check_campaign_recipient_tenant_matches_campaign();

alter table public.campaign_recipients enable row level security;

create policy campaign_recipients_select on public.campaign_recipients
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy campaign_recipients_insert on public.campaign_recipients
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.campaign_recipients from anon;
grant select, insert on public.campaign_recipients to authenticated;

-- Enlaza la conversación que arrancó una campaña con la campaña misma, para
-- que whatsapp-ai-respond pueda encontrar el "tema" cuando el contacto
-- responda. Nullable: la inmensa mayoría de conversaciones no vienen de
-- ninguna campaña.
alter table public.whatsapp_conversations add column campaign_id uuid references public.campaigns(id) on delete set null;
create index idx_whatsapp_conversations_campaign_id on public.whatsapp_conversations(campaign_id) where campaign_id is not null;
