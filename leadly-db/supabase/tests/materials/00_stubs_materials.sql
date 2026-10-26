-- Esquema minimo que la migracion de insumos toca y que 00_stubs.sql no trae.
set client_min_messages = warning;
create table public.permission_actions(key text primary key, module_key text not null, name text, description text, display_order int not null default 0);
create table public.tenant_enabled_modules(tenant_id uuid, module_key text not null);
create table public.billing_plan_modules(plan_id uuid, module_key text not null);
create table public.billing_subscription_modules(subscription_id uuid, module_key text not null);
alter table public.sales_orders add column if not exists billing_address_id uuid;
alter table public.sales_orders add column if not exists shipping_address_id uuid;
alter table public.product_variants add column if not exists is_active boolean not null default true;
