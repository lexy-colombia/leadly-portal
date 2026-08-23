-- Redimir saldo a favor (store_credit_grants, ver 20260823020001_returns.sql)
-- en una venta nueva -- pedido explícito del usuario 2026-08-23: "cruzar
-- los saldos a favor en las compras". Mismo mecanismo que 'credito'
-- (20260822020001_customer_credit.sql) pero en la dirección contraria: en
-- vez de cargar deuda, DESCUENTA saldo ya a favor del cliente. No es un
-- ingreso real de plata -- por eso method='saldo_favor' no debería sumar a
-- "Ingresos por método de pago" en el resumen de Órdenes (ver frontend).

-- =====================================================================
-- 1. store_credit_redemptions -- ledger append-only, mismo patrón que
--    credit_charges: nace del trigger de abajo, nunca se edita a mano.
--    Balance de saldo a favor = sum(store_credit_grants) -
--    sum(store_credit_redemptions), por cliente.
-- =====================================================================

create table public.store_credit_redemptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  sales_order_id uuid not null references public.sales_orders(id) on delete cascade,
  sales_order_payment_id uuid not null unique references public.sales_order_payments(id) on delete cascade,
  amount numeric(14, 2) not null check (amount > 0),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index store_credit_redemptions_tenant_id_idx on public.store_credit_redemptions(tenant_id);
create index store_credit_redemptions_client_id_idx on public.store_credit_redemptions(client_id);

alter table public.store_credit_redemptions enable row level security;

create policy store_credit_redemptions_select on public.store_credit_redemptions
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy store_credit_redemptions_insert on public.store_credit_redemptions
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.store_credit_redemptions from anon;

-- =====================================================================
-- 2. sales_order_payments: nuevo método 'saldo_favor'.
-- =====================================================================

alter table public.sales_order_payments drop constraint sales_order_payments_method_check;
alter table public.sales_order_payments add constraint sales_order_payments_method_check
  check (method in ('efectivo', 'transferencia', 'tarjeta', 'otro', 'credito', 'saldo_favor'));

-- =====================================================================
-- 3. Efecto automático: un pago de orden con method='saldo_favor'
--    descuenta el saldo a favor del cliente. Rechaza si no alcanza --
--    defensa en profundidad, mismo criterio que apply_credit_payment_charge().
-- =====================================================================

create or replace function public.apply_store_credit_redemption()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_balance numeric;
begin
  if new.method <> 'saldo_favor' then
    return new;
  end if;

  select contact_id into v_client_id from public.sales_orders where id = new.order_id;

  select coalesce((select sum(amount) from public.store_credit_grants where client_id = v_client_id), 0)
       - coalesce((select sum(amount) from public.store_credit_redemptions where client_id = v_client_id), 0)
    into v_balance;

  if new.amount > v_balance then
    raise exception 'El cliente no tiene suficiente saldo a favor (disponible: %)', v_balance;
  end if;

  insert into public.store_credit_redemptions (tenant_id, client_id, sales_order_id, sales_order_payment_id, amount, created_by)
  values (new.tenant_id, v_client_id, new.order_id, new.id, new.amount, new.created_by);

  return new;
end;
$$;

create trigger trg_sales_order_payments_credit_redemption
  after insert on public.sales_order_payments
  for each row execute function public.apply_store_credit_redemption();
