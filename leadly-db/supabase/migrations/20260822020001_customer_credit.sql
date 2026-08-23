-- Cartera de clientes (crédito), pedido explícito del usuario 2026-08-22:
-- un cliente puede tener habilitado el método de pago "crédito" en sus
-- ventas -- eso no cobra nada en el momento, sino que carga la deuda a su
-- cuenta de crédito. Pagar esa deuda con el tiempo (abonos) es un flujo
-- completamente aparte de pagar una orden puntual, con su propio recibo.
--
-- Regla dura pedida explícitamente: una vez que una orden deja de ser
-- 'cotizacion' (se confirma como venta, o se anula), ninguno de sus pagos
-- puede modificarse ni eliminarse por ningún motivo -- ni para "corregir"
-- el método, ni para borrarlo y recrearlo con otro método. Eso es lo que
-- impediría que alguien cambie un crédito ya cargado por un pago en
-- efectivo (o viceversa) después de cerrada la venta. Se aplica con un
-- trigger, no solo en el frontend, porque es una regla de integridad
-- financiera, no una preferencia de UX.

-- =====================================================================
-- 1. clients.credit_enabled -- habilita la opción "crédito" como método de
--    pago para las órdenes de ese cliente específico.
-- =====================================================================

alter table public.clients add column credit_enabled boolean not null default false;

-- =====================================================================
-- 2. sales_order_payments: nuevo método 'credito'.
-- =====================================================================

alter table public.sales_order_payments drop constraint sales_order_payments_method_check;
alter table public.sales_order_payments add constraint sales_order_payments_method_check
  check (method in ('efectivo', 'transferencia', 'tarjeta', 'otro', 'credito'));

-- =====================================================================
-- 3. credit_charges -- cargos a la cuenta de crédito del cliente. Append-
--    only (mismo patrón que opportunity_stage_history/sales_order_comments):
--    un cargo nace automáticamente cuando se registra un pago de orden con
--    method='credito', nunca se edita ni se borra a mano.
-- =====================================================================

create table public.credit_charges (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  sales_order_id uuid not null references public.sales_orders(id) on delete cascade,
  sales_order_payment_id uuid not null unique references public.sales_order_payments(id) on delete cascade,
  amount numeric(14, 2) not null check (amount > 0),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index credit_charges_tenant_id_idx on public.credit_charges(tenant_id);
create index credit_charges_client_id_idx on public.credit_charges(client_id);

alter table public.credit_charges enable row level security;

create policy credit_charges_select on public.credit_charges
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy credit_charges_insert on public.credit_charges
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.credit_charges from anon;

-- =====================================================================
-- 4. credit_payments -- abonos que el cliente hace contra su saldo de
--    crédito general (no contra una orden puntual). Cada uno tiene un
--    número de recibo secuencial por tenant, mismo patrón que
--    sales_orders.number. 'credito' no es un método válido acá -- pagar
--    crédito con crédito no tiene sentido.
-- =====================================================================

create table public.credit_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  receipt_number integer not null,
  method text not null check (method in ('efectivo', 'transferencia', 'tarjeta', 'otro')),
  amount numeric(14, 2) not null check (amount > 0),
  currency text not null default 'COP',
  paid_at date not null default current_date,
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null
);

create index credit_payments_tenant_id_idx on public.credit_payments(tenant_id);
create index credit_payments_client_id_idx on public.credit_payments(client_id);
create unique index credit_payments_tenant_id_receipt_number_idx on public.credit_payments(tenant_id, receipt_number);

create trigger credit_payments_set_updated_at
  before update on public.credit_payments
  for each row execute function public.set_updated_at();

alter table public.credit_payments enable row level security;

create policy credit_payments_select on public.credit_payments
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy credit_payments_insert on public.credit_payments
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy credit_payments_update on public.credit_payments
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy credit_payments_delete on public.credit_payments
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.credit_payments from anon;

create or replace function public.set_credit_payment_receipt_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select coalesce(max(receipt_number), 0) + 1 into new.receipt_number
    from public.credit_payments where tenant_id = new.tenant_id;
  return new;
end;
$$;

create trigger trg_credit_payments_set_receipt_number
  before insert on public.credit_payments
  for each row execute function public.set_credit_payment_receipt_number();

-- =====================================================================
-- 5. Efecto automático: un pago de orden con method='credito' carga la
--    cuenta de crédito del cliente. Validado también acá (no solo en la
--    UI) -- defensa en profundidad, mismo criterio que isToolAllowed en
--    whatsapp-ai-tools.
-- =====================================================================

create or replace function public.apply_credit_payment_charge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_client_credit_enabled boolean;
  v_order_number integer;
begin
  if new.method <> 'credito' then
    return new;
  end if;

  select o.contact_id, o.number into v_client_id, v_order_number
    from public.sales_orders o where o.id = new.order_id;

  select credit_enabled into v_client_credit_enabled
    from public.clients where id = v_client_id;

  if not coalesce(v_client_credit_enabled, false) then
    raise exception 'El cliente no tiene crédito habilitado';
  end if;

  insert into public.credit_charges (tenant_id, client_id, sales_order_id, sales_order_payment_id, amount, notes, created_by)
  values (new.tenant_id, v_client_id, new.order_id, new.id, new.amount, 'Cargo por orden #' || v_order_number, new.created_by);

  return new;
end;
$$;

create trigger trg_sales_order_payments_credit_charge
  after insert on public.sales_order_payments
  for each row execute function public.apply_credit_payment_charge();

-- =====================================================================
-- 6. Inmutabilidad: ningún pago de una orden que ya no está en
--    'cotizacion' puede modificarse ni eliminarse (ni siquiera vía DELETE
--    directo -- solo la app usa soft-delete, pero esto cubre también el
--    caso de alguien operando con SQL directo).
-- =====================================================================

create or replace function public.guard_sales_order_payment_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  select status into v_status from public.sales_orders where id = old.order_id;
  if v_status is distinct from 'cotizacion' then
    raise exception 'No se puede modificar ni eliminar un pago de una orden que ya no está en cotización (estado actual: %)', v_status;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger trg_sales_order_payments_immutable_update
  before update on public.sales_order_payments
  for each row execute function public.guard_sales_order_payment_immutable();

create trigger trg_sales_order_payments_immutable_delete
  before delete on public.sales_order_payments
  for each row execute function public.guard_sales_order_payment_immutable();

-- =====================================================================
-- 7. Módulo togglable por tenant, mismo patrón que 'inventory'/
--    'integrations'. Deshabilitado por defecto para todo tenant existente.
-- =====================================================================

alter table public.tenant_enabled_modules drop constraint tenant_enabled_modules_module_key_check;
alter table public.tenant_enabled_modules add constraint tenant_enabled_modules_module_key_check check (module_key in (
  'dashboard', 'conversations', 'contacts', 'pipeline', 'products', 'sales',
  'tasks', 'calendar', 'campaigns', 'reports', 'automations', 'aiAgents',
  'billing', 'integrations', 'inventory', 'settings', 'credit'
));
