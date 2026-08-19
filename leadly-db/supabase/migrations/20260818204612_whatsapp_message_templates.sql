-- Plantillas de WhatsApp (HSM) por tenant -- ver CLAUDE.md, Fase 1 de
-- "iniciar conversaciones". Cada tenant conecta su propia WABA (Embedded
-- Signup), así que estas plantillas son propiedad del tenant, no un catálogo
-- curado por Leadly (a diferencia de ai_skills). business_account_id se
-- denormaliza acá para las llamadas a la Graph API sin tener que resolver la
-- línea en cada request -- Fase 1 asume una sola WABA activa por tenant (la
-- primera línea activa), documentado como simplificación deliberada.

create table public.whatsapp_message_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  business_account_id varchar(40) not null,
  meta_template_id varchar(60),
  name varchar(512) not null,
  category varchar(20) not null check (category in ('MARKETING', 'UTILITY', 'AUTHENTICATION')),
  language varchar(10) not null,
  status varchar(20) not null default 'PENDING'
    check (status in ('PENDING', 'APPROVED', 'REJECTED', 'PAUSED', 'DISABLED')),
  body_text text not null,
  variable_count integer not null default 0 check (variable_count >= 0),
  rejected_reason text,
  created_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_message_templates_name_not_blank check (btrim(name) <> ''),
  constraint whatsapp_message_templates_body_not_blank check (btrim(body_text) <> ''),
  unique (tenant_id, name, language)
);
comment on table public.whatsapp_message_templates is 'Tenant-owned WhatsApp HSM templates submitted to Meta for approval against the tenant''s WABA (business_account_id). Fase 1: solo cuerpo con variables posicionales {{n}}, sin encabezado/imagen/botones.';

create index idx_whatsapp_message_templates_tenant_id on public.whatsapp_message_templates(tenant_id) where deleted_at is null;
create index idx_whatsapp_message_templates_tenant_status on public.whatsapp_message_templates(tenant_id, status) where deleted_at is null;

create trigger trg_whatsapp_message_templates_updated_at before update on public.whatsapp_message_templates
  for each row execute function public.set_updated_at();

alter table public.whatsapp_message_templates enable row level security;

-- A diferencia de ai_skills (catálogo curado por superadmin, solo lectura
-- para el tenant), acá el tenant es dueño real de sus plantillas: las crea,
-- las edita mientras siguen PENDING, y las soft-elimina. Ver ai_skills como
-- contraejemplo intencional, no como el patrón a copiar acá.
create policy whatsapp_message_templates_select on public.whatsapp_message_templates
  for select using ((tenant_id = public.auth_active_tenant_id() or public.is_superadmin()) and deleted_at is null);

create policy whatsapp_message_templates_insert on public.whatsapp_message_templates
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

create policy whatsapp_message_templates_update on public.whatsapp_message_templates
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.whatsapp_message_templates from anon;
grant select, insert, update on public.whatsapp_message_templates to authenticated;
