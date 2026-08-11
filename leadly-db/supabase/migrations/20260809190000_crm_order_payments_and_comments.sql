-- Detalle de venta/cotización (/app/ventas/:id) -- pedido explícito del
-- usuario, inspirado en el detalle de "purchase" del portal de seeri
-- (Desktop/seeri/suppliers-web), acotado a lo que tiene sentido con el
-- modelo de datos actual. Dos piezas nuevas: pagos parciales/totales contra
-- una venta, y una bitácora de comentarios (con adjuntos opcionales) -- no
-- existía ninguna de las dos hasta ahora.

-- Mismo patrón soft-delete que crm_tasks (20260806000005) -- un pago mal
-- cargado se elimina y se vuelve a crear, no se edita.
create table public.crm_order_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.crm_orders(id) on delete cascade,
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

create index crm_order_payments_tenant_id_idx on public.crm_order_payments(tenant_id);
create index crm_order_payments_order_id_idx on public.crm_order_payments(order_id);

create trigger crm_order_payments_set_updated_at
  before update on public.crm_order_payments
  for each row execute function public.set_updated_at();

alter table public.crm_order_payments enable row level security;

create policy crm_order_payments_select on public.crm_order_payments
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_order_payments_insert on public.crm_order_payments
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_order_payments_update on public.crm_order_payments
  for update using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin())
  with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_order_payments_delete on public.crm_order_payments
  for delete using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_order_payments from anon;

-- Bitácora append-only, mismo criterio que crm_notes ("Sin políticas de
-- update/delete a propósito") -- no se replica el edit/delete de comentario
-- propio que tiene el detalle de seeri, se sigue la convención ya usada acá.
create table public.crm_order_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  order_id uuid not null references public.crm_orders(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  content text not null,
  created_at timestamptz not null default now()
);

create index crm_order_comments_order_id_idx on public.crm_order_comments(order_id);

alter table public.crm_order_comments enable row level security;

create policy crm_order_comments_select on public.crm_order_comments
  for select using (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());
create policy crm_order_comments_insert on public.crm_order_comments
  for insert with check (tenant_id = public.auth_active_tenant_id() or public.is_superadmin());

revoke all on public.crm_order_comments from anon;

-- Extiende crm_attachments (mismo patrón que 20260806000012_crm_task_attachments.sql,
-- que ya le agregó task_id) para poder adjuntar una foto a un comentario de
-- venta -- sigue siendo solo imágenes (evidencia/comprobante), no se
-- relaja a application/pdf como en tareas.
alter table public.crm_attachments add column order_comment_id uuid references public.crm_order_comments(id) on delete cascade;
create index crm_attachments_order_comment_id_idx on public.crm_attachments(order_comment_id);

alter table public.crm_attachments drop constraint crm_attachments_exactly_one_parent;
alter table public.crm_attachments add constraint crm_attachments_exactly_one_parent check (
  (case when pqr_id is not null then 1 else 0 end)
  + (case when pqr_update_id is not null then 1 else 0 end)
  + (case when task_id is not null then 1 else 0 end)
  + (case when order_comment_id is not null then 1 else 0 end) = 1
);
