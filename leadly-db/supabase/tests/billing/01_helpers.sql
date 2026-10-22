-- Ayudantes de prueba (esquema t, creado por los stubs).
set client_min_messages = warning;
create table t.ids(k text primary key, id uuid);
grant all on t.ids to public;
create function t.id(p_k text) returns uuid language sql stable as $$ select id from t.ids where k = p_k $$;
create function t.tenant(p_k text) returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.tenants(name) values ('zz ' || p_k) returning id into v;
  insert into t.ids values (p_k, v);
  return v;
end $$;

-- Ejecuta p_sql con claims JWT simulados y (opcional) SET LOCAL ROLE; devuelve ok/mensaje.
-- p_role NULL = sin claims y rol postgres (pg_cron / SQL directo).
create function t.as_user(p_role text, p_uid uuid, p_sql text, out ok boolean, out msg text) language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    case when p_role is null then '' else json_build_object('role', p_role, 'sub', p_uid)::text end, true);
  if p_role in ('anon', 'authenticated', 'service_role') then execute format('set local role %I', p_role); end if;
  begin
    execute p_sql; ok := true; msg := null;
  exception when others then ok := false; msg := sqlerrm;
  end;
  reset role;
  perform set_config('request.jwt.claims', '', true);
end $$;

create function t.run_as(p_name text, p_role text, p_uid uuid, p_sql text, p_expect_ok boolean, p_pattern text default null)
returns void language plpgsql as $$
declare r record;
begin
  select * into r from t.as_user(p_role, p_uid, p_sql);
  perform t.chk(p_name, r.ok = p_expect_ok and (p_expect_ok or p_pattern is null or r.msg ilike p_pattern),
                'ok=' || r.ok || ' msg=' || coalesce(r.msg, '-'));
end $$;

create function t.mk_inv(p_tenant uuid, p_due date, p_status text default 'PENDING') returns uuid language sql as $$
  insert into public.payment_invoices(payer_tenant_id, provider_key, amount_cents, status, due_date, invoice_number)
  values (p_tenant, 'wompi', 1000000, p_status, p_due, 'INV-ZZ-' || substr(gen_random_uuid()::text, 1, 6))
  returning id $$;
