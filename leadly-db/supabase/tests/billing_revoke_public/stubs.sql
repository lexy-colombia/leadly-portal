-- Estado "vivo" previo: funciones definer con el grant por defecto (PUBLIC)
-- y el revoke incompleto de 20260807173703 (solo anon, authenticated).
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
grant usage on schema public to anon, authenticated, service_role;

create table public.payment_invoices(id serial primary key, status text, due_date date);
create table public.tenants(id serial primary key, status text);
create table public.runs(fn text, at timestamptz default now());
insert into public.payment_invoices(status, due_date) values ('PENDING', current_date - 10);
insert into public.tenants(status) values ('active');

create function public.mark_overdue_invoices() returns void language sql security definer
set search_path = public as $$
  update public.payment_invoices set status='OVERDUE' where status='PENDING' and due_date < current_date;
  insert into public.runs(fn) values ('mark_overdue_invoices');
$$;
create function public.deactivate_tenants_with_overdue_invoices() returns void language plpgsql security definer
set search_path = public as $$
begin
  perform public.mark_overdue_invoices();
  update public.tenants set status='inactive' where status='active'
    and exists (select 1 from public.payment_invoices where status in ('PENDING','OVERDUE'));
  insert into public.runs(fn) values ('deactivate_tenants_with_overdue_invoices');
end $$;
create function public.process_recurring_billing_invoices() returns void language plpgsql security definer
set search_path = public as $$
begin insert into public.runs(fn) values ('process_recurring_billing_invoices'); end $$;

-- el revoke incompleto de la migracion 20260807173703 (linea 26 y analogas)
revoke execute on function public.process_recurring_billing_invoices() from anon, authenticated;
