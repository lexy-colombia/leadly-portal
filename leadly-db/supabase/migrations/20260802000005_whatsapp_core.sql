-- WhatsApp lines, per-line AI assistant config, conversations and the
-- immutable message ledger. Reference: CLAUDE.md secciones 3.2 y 3.3.

create table public.whatsapp_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  phone_number_id varchar(40) not null unique,
  business_account_id varchar(40) not null,
  access_token_secret_id uuid,
  display_name varchar(80) not null,
  status varchar(30) not null default 'pending_verification'
    check (status in ('pending_verification', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint whatsapp_lines_display_name_not_blank check (btrim(display_name) <> '')
);
comment on table public.whatsapp_lines is 'One row per WhatsApp Business phone number assigned to a tenant. access_token_secret_id points to a Supabase Vault secret (vault.secrets.id), never store the raw Meta token here.';

create index idx_whatsapp_lines_tenant_id on public.whatsapp_lines(tenant_id);

create table public.ai_assistants (
  id uuid primary key default gen_random_uuid(),
  whatsapp_line_id uuid not null unique references public.whatsapp_lines(id) on delete cascade,
  provider varchar(20) not null,
  model varchar(60) not null,
  system_prompt text not null default '',
  temperature numeric(3,2) not null default 0.70 check (temperature >= 0 and temperature <= 2),
  max_tokens integer not null default 1024 check (max_tokens > 0 and max_tokens <= 8192),
  is_active boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (provider, model) references public.ai_models(provider, model_code)
);
comment on table public.ai_assistants is 'One AI configuration per WhatsApp line. provider/model is validated against ai_models so the UI select and the DB always agree on valid combinations.';

create table public.whatsapp_conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete restrict,
  whatsapp_line_id uuid not null references public.whatsapp_lines(id) on delete restrict,
  contact_phone varchar(30) not null,
  contact_name varchar(150),
  mode varchar(10) not null default 'ia' check (mode in ('ia', 'humano')),
  status varchar(10) not null default 'open' check (status in ('open', 'closed')),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (whatsapp_line_id, contact_phone)
);
comment on table public.whatsapp_conversations is 'One thread per (line, contact). mode=humano pauses automatic AI replies for this thread.';

create index idx_whatsapp_conversations_tenant_id on public.whatsapp_conversations(tenant_id);
create index idx_whatsapp_conversations_line_id on public.whatsapp_conversations(whatsapp_line_id);
create index idx_whatsapp_conversations_last_message_at on public.whatsapp_conversations(last_message_at desc nulls last);

create table public.whatsapp_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.whatsapp_conversations(id) on delete cascade,
  direction varchar(10) not null check (direction in ('inbound', 'outbound')),
  sender_type varchar(10) not null check (sender_type in ('contact', 'ia', 'agent')),
  sender_profile_id uuid references public.profiles(id) on delete set null,
  content text not null,
  wamid varchar(100),
  tokens_used integer check (tokens_used is null or tokens_used >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  constraint whatsapp_messages_content_not_blank check (btrim(content) <> ''),
  constraint whatsapp_messages_sender_profile_only_for_agent check (
    (sender_type = 'agent' and sender_profile_id is not null)
    or (sender_type <> 'agent' and sender_profile_id is null)
  ),
  constraint whatsapp_messages_direction_sender_consistency check (
    (direction = 'inbound' and sender_type = 'contact')
    or (direction = 'outbound' and sender_type in ('ia', 'agent'))
  )
);
comment on table public.whatsapp_messages is 'Append-only ledger. No update/delete policy is granted to any client role -- see RLS migration.';

create index idx_whatsapp_messages_conversation_id_created_at on public.whatsapp_messages(conversation_id, created_at);

-- updated_at maintenance
create trigger trg_whatsapp_lines_updated_at before update on public.whatsapp_lines
  for each row execute function public.set_updated_at();
create trigger trg_ai_assistants_updated_at before update on public.ai_assistants
  for each row execute function public.set_updated_at();
create trigger trg_whatsapp_conversations_updated_at before update on public.whatsapp_conversations
  for each row execute function public.set_updated_at();

-- Hardening: tenant_id on whatsapp_conversations is denormalized for fast RLS
-- (avoids a join on every row read). Enforce with a trigger that it always
-- matches the parent whatsapp_lines.tenant_id, so a client/app bug can never
-- create a conversation "leaking" into the wrong tenant's inbox.
create or replace function public.check_conversation_tenant_matches_line()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  line_tenant_id uuid;
begin
  select tenant_id into line_tenant_id from public.whatsapp_lines where id = new.whatsapp_line_id;
  if line_tenant_id is null then
    raise exception 'whatsapp_line_id % does not exist', new.whatsapp_line_id;
  end if;
  if new.tenant_id is distinct from line_tenant_id then
    raise exception 'tenant_id must match the tenant_id of whatsapp_line_id';
  end if;
  return new;
end;
$$;

revoke execute on function public.check_conversation_tenant_matches_line() from public;

create trigger trg_whatsapp_conversations_tenant_check
  before insert or update of tenant_id, whatsapp_line_id on public.whatsapp_conversations
  for each row execute function public.check_conversation_tenant_matches_line();

-- last_message_at is derived from whatsapp_messages, keep it in sync automatically
-- instead of trusting every write-path to remember to update it.
create or replace function public.bump_conversation_last_message_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.whatsapp_conversations
    set last_message_at = new.created_at
    where id = new.conversation_id;
  return new;
end;
$$;

revoke execute on function public.bump_conversation_last_message_at() from public;

create trigger trg_whatsapp_messages_bump_conversation
  after insert on public.whatsapp_messages
  for each row execute function public.bump_conversation_last_message_at();
