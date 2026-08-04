-- Catalog of AI provider/model combinations selectable from the UI.
-- Kept as data (not a CHECK constraint) so new models can be enabled/disabled
-- without a schema migration -- this is what backs the "select proveedor +
-- select modelo dependiente" requirement: the UI loads this table and filters
-- model options by the chosen provider.

create table public.ai_models (
  provider varchar(20) not null check (provider in ('openai', 'gemini')),
  model_code varchar(60) not null,
  display_name varchar(80) not null,
  is_active boolean not null default true,
  display_order integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (provider, model_code)
);
comment on table public.ai_models is 'Selectable provider/model combinations for ai_assistants. Global catalog, not tenant-scoped.';

alter table public.ai_models enable row level security;

create policy ai_models_read_all on public.ai_models
  for select using (true);

create policy ai_models_superadmin_write on public.ai_models
  for insert with check (public.is_superadmin());

create policy ai_models_superadmin_update on public.ai_models
  for update using (public.is_superadmin()) with check (public.is_superadmin());

create policy ai_models_superadmin_delete on public.ai_models
  for delete using (public.is_superadmin());

revoke all on public.ai_models from anon;

insert into public.ai_models (provider, model_code, display_name, display_order) values
  ('openai', 'gpt-4.1', 'GPT-4.1', 1),
  ('openai', 'gpt-4.1-mini', 'GPT-4.1 mini', 2),
  ('openai', 'gpt-4o', 'GPT-4o', 3),
  ('openai', 'gpt-4o-mini', 'GPT-4o mini', 4),
  ('gemini', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 1),
  ('gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 2),
  ('gemini', 'gemini-2.0-flash', 'Gemini 2.0 Flash', 3);
