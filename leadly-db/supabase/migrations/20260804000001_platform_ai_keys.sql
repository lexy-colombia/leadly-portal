-- Platform-wide OpenAI/Gemini API keys, managed from the backoffice instead
-- of only via `supabase secrets set` on the CLI (see CLAUDE.md 1: "Leadly usa
-- keys propias compartidas" -- these are global, not per-tenant). Same
-- write-only Vault pattern as whatsapp_lines.access_token_secret_id
-- (20260802000012): the frontend can set/replace a key and check whether one
-- is configured, but can never read the raw value back.

create table public.platform_ai_keys (
  provider text primary key check (provider in ('openai', 'gemini')),
  secret_id uuid not null,
  updated_at timestamptz not null default now()
);

alter table public.platform_ai_keys enable row level security;
-- No policies granted to anon/authenticated at all -- every access goes
-- through the SECURITY DEFINER functions below, which do their own
-- superadmin/service_role checks. The table itself is invisible to clients.
revoke all on public.platform_ai_keys from anon, authenticated;

create or replace function public.set_platform_ai_key(p_provider text, p_key text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_existing_secret_id uuid;
begin
  if not public.is_superadmin() then
    raise exception 'Only superadmin can set platform AI keys';
  end if;

  if p_provider not in ('openai', 'gemini') then
    raise exception 'Invalid provider: %', p_provider;
  end if;

  if btrim(coalesce(p_key, '')) = '' then
    raise exception 'p_key is required';
  end if;

  select secret_id into v_existing_secret_id from public.platform_ai_keys where provider = p_provider;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_key);
    update public.platform_ai_keys set updated_at = now() where provider = p_provider;
  else
    insert into public.platform_ai_keys (provider, secret_id)
    values (p_provider, vault.create_secret(p_key, 'platform_ai_key_' || p_provider, 'Leadly-wide API key for ' || p_provider));
  end if;
end;
$$;

revoke execute on function public.set_platform_ai_key(text, text) from public, anon;
grant execute on function public.set_platform_ai_key(text, text) to authenticated;

-- Lets the backoffice show "configurada" / "sin configurar" without ever
-- exposing the value itself.
create or replace function public.has_platform_ai_key(p_provider text)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only superadmin can check platform AI key status';
  end if;
  return exists (select 1 from public.platform_ai_keys where provider = p_provider);
end;
$$;

revoke execute on function public.has_platform_ai_key(text) from public, anon;
grant execute on function public.has_platform_ai_key(text) to authenticated;

-- Read path: only whatsapp-ai-respond (service_role) may call this -- no
-- browser client, not even a superadmin session, should ever be able to pull
-- the raw key back out.
create or replace function public.get_platform_ai_key(p_provider text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_key text;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Not authorized to read platform AI keys';
  end if;

  select secret_id into v_secret_id from public.platform_ai_keys where provider = p_provider;
  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_key from vault.decrypted_secrets where id = v_secret_id;
  return v_key;
end;
$$;

revoke execute on function public.get_platform_ai_key(text) from public, anon, authenticated;
grant execute on function public.get_platform_ai_key(text) to service_role;
