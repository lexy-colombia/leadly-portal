-- Cliente de mostrador ("Consumidor Final") sembrado por tenant -- una
-- venta POS necesita poder facturarse SIN pedirle nada al cliente
-- (sales_orders.contact_id es not null, no hay forma de dejarlo vacío).
-- Mismo patrón que seed_default_warehouse()/seed_default_pipeline().
--
-- El documento 13/222222222222 no es arbitrario -- es el mismo valor que
-- aparece como "consumidor final" en una factura POS real que se usó de
-- referencia en esta sesión, así que un tenant con DIAN activo nunca va a
-- tener sus facturas POS bloqueadas en blocked_missing_buyer_data por falta
-- de documento del comprador.
alter table public.clients add column is_walk_in boolean not null default false;

create or replace function public.seed_default_walkin_client()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into public.clients (tenant_id, full_name, phone_prefix, phone, dian_document_type_code, document_number, is_walk_in)
  values (new.id, 'Consumidor Final', '57', '3000000000', '13', '222222222222', true);
  return new;
end;
$$;

revoke execute on function public.seed_default_walkin_client() from public, anon, authenticated;

create trigger tenants_seed_default_walkin_client
  after insert on public.tenants
  for each row execute function public.seed_default_walkin_client();

-- Backfill de los tenants existentes que todavía no tengan uno.
insert into public.clients (tenant_id, full_name, phone_prefix, phone, dian_document_type_code, document_number, is_walk_in)
select t.id, 'Consumidor Final', '57', '3000000000', '13', '222222222222', true
from public.tenants t
where not exists (select 1 from public.clients c where c.tenant_id = t.id and c.is_walk_in);
