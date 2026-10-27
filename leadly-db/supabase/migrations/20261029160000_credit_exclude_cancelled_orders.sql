-- ST5 (feature_api_hardening): un cargo de credito cuyo pedido fue anulado
-- (status = 'cancelada') o borrado (deleted_at) YA NO cuenta en el saldo.
--
-- Decision del usuario (2026-10-26): "corrige los errores incluyendo el
-- credito anulado". Antes (ST4, migracion 20261029150000) se reproducia la regla
-- vieja: anular la venta no revertia el cargo, y el cliente seguia debiendo
-- una venta que ya no existe. Hoy hay 1 caso en produccion (cargo
-- 2c92de7e-..., pedido #488 cancelada, 111.300).
--
-- Regla nueva: el cargo cuenta solo si su pedido (sales_orders.id =
-- credit_charges.sales_order_id, mismo tenant) existe, deleted_at is null y
-- status <> 'cancelada'. credit_charges.sales_order_id es NOT NULL con
-- FK on delete cascade, asi que un pedido borrado "de verdad" ya se lleva su
-- cargo; esto cubre el soft-delete y la anulacion. total_charged y balance
-- usan el MISMO conjunto de cargos (balance = total_charged - total_paid).
-- Los pagos (abonos) no cambian: pagos soft-deleted siguen sin contar.
-- Nota: si el cliente ya habia abonado contra el cargo excluido, el saldo
-- puede quedar negativo (a favor); no se corrige aqui.
--
-- Firmas, security invoker, search_path y grants IDENTICOS a ST4 (create or
-- replace conserva los grants existentes).

create or replace function public.get_client_credit_summary(p_client_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
  select jsonb_build_object(
    'total_charged', t.charged,
    'total_paid', t.paid,
    'balance', t.charged - t.paid
  )
  from public.clients c
  cross join lateral (
    select
      coalesce((
        select sum(ch.amount) from public.credit_charges ch
        where ch.client_id = c.id and ch.tenant_id = c.tenant_id
          and exists (
            select 1 from public.sales_orders o
            where o.id = ch.sales_order_id and o.tenant_id = ch.tenant_id
              and o.deleted_at is null and o.status <> 'cancelada')), 0) as charged,
      coalesce((
        select sum(p.amount) from public.credit_payments p
        where p.client_id = c.id and p.tenant_id = c.tenant_id and p.deleted_at is null), 0) as paid
  ) t
  where c.id = p_client_id;   -- cliente no visible / inexistente -> null (no ceros inventados)
$$;

create or replace function public.list_credit_clients(
  p_page integer default 1,
  p_page_size integer default 10
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_tenant uuid := public.auth_active_tenant_id();
  v_size integer := least(greatest(coalesce(p_page_size, 10), 1), 100);
  v_page integer := greatest(coalesce(p_page, 1), 1);
  v_rows jsonb;
  v_summary jsonb;
begin
  if v_tenant is null then
    return jsonb_build_object(
      'rows', '[]'::jsonb,
      'total', 0,
      'summary', jsonb_build_object('clients', 0, 'with_balance', 0, 'total_charged', 0, 'total_paid', 0, 'total_balance', 0)
    );
  end if;

  with base as (
    select c.id, c.full_name,
           coalesce((select sum(ch.amount) from public.credit_charges ch
                     where ch.client_id = c.id and ch.tenant_id = v_tenant
                       and exists (
                         select 1 from public.sales_orders o
                         where o.id = ch.sales_order_id and o.tenant_id = v_tenant
                           and o.deleted_at is null and o.status <> 'cancelada')), 0) as total_charged,
           coalesce((select sum(p.amount) from public.credit_payments p where p.client_id = c.id and p.tenant_id = v_tenant and p.deleted_at is null), 0) as total_paid
    from public.clients c
    where c.tenant_id = v_tenant and c.credit_enabled = true and c.deleted_at is null
  ),
  pg as (
    select * from base order by full_name, id offset (v_page - 1) * v_size limit v_size
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
                'client', jsonb_build_object('id', pg.id, 'full_name', pg.full_name),
                'total_charged', pg.total_charged,
                'total_paid', pg.total_paid,
                'balance', pg.total_charged - pg.total_paid) order by pg.full_name, pg.id) from pg), '[]'::jsonb),
    (select jsonb_build_object(
        'clients', count(*),
        'with_balance', count(*) filter (where total_charged - total_paid > 0),
        'total_charged', coalesce(sum(total_charged), 0),
        'total_paid', coalesce(sum(total_paid), 0),
        'total_balance', coalesce(sum(total_charged - total_paid), 0)) from base)
  into v_rows, v_summary;

  return jsonb_build_object('rows', v_rows, 'total', (v_summary->>'clients')::bigint, 'summary', v_summary);
end;
$$;

-- Aviso de seguridad: trigger_sales_lead_alerts (security definer, lee el
-- secreto del Vault y llama a la Edge Function) era ejecutable por anon y
-- authenticated. Solo la usa el cron (job send-sales-lead-alerts, corre como
-- el rol que lo programo: postgres, dueno de la funcion, conserva ejecucion)
-- y service_role (no se le revoca).
revoke execute on function public.trigger_sales_lead_alerts() from public, anon, authenticated;
