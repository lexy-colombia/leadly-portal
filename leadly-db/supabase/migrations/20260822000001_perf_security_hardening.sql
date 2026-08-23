-- Limpieza de deuda técnica detectada por los Supabase advisors (security +
-- performance) el 2026-08-22, tras 174+ migraciones aditivas sin que nadie
-- revisara nunca los advisors en conjunto. Nada de esto cambia comportamiento
-- ni permisos observables por un tenant real -- son índices que faltaban y
-- policies RLS reescritas para que Postgres las evalúe una sola vez por fila
-- en vez de varias, con exactamente la misma lógica de autorización.
--
-- Deliberadamente fuera de esta migración (evaluado y descartado, no
-- olvidado):
-- 1. `rls_enabled_no_policy` en `integration_credential_secrets`,
--    `payment_credential_secrets`, `platform_ai_keys` -- es el diseño
--    correcto (deny-all real, solo accesibles vía RPC `security definer`,
--    mismo patrón que el Vault del token de Meta). Tocarlas sería
--    introducir el bug, no arreglarlo.
-- 2. `extension_in_public` (pg_net) -- sus funciones ya se llaman
--    calificadas como `net.http_post(...)` desde los cron jobs de
--    recordatorios de citas y campañas (código ya en prod). Mover la
--    extensión de esquema es una operación de una sola vía sin ambiente de
--    staging separado -- se deja fuera a propósito, requiere ventana propia.
-- 3. `auth_leaked_password_protection` -- toggle del dashboard de Supabase
--    Auth, no una migración SQL.

-- =====================================================================
-- PARTE 1: índices para las 58 foreign keys sin índice de cobertura
-- (evita full scans en cada join/RLS check sobre estas columnas a medida
-- que crecen los tenants reales).
-- =====================================================================

create index if not exists idx_ai_assistant_skills_enabled_by on public.ai_assistant_skills (enabled_by);
create index if not exists idx_ai_assistant_skills_skill_key on public.ai_assistant_skills (skill_key);
create index if not exists idx_ai_assistants_provider_model on public.ai_assistants (provider, model);
create index if not exists idx_ai_assistants_updated_by on public.ai_assistants (updated_by);
create index if not exists idx_ai_tool_executions_tenant_id on public.ai_tool_executions (tenant_id);
create index if not exists idx_appointments_created_by on public.appointments (created_by);
create index if not exists idx_appointments_tenant_id on public.appointments (tenant_id);
create index if not exists idx_appointments_whatsapp_line_id on public.appointments (whatsapp_line_id);
create index if not exists idx_attachments_created_by on public.attachments (created_by);
create index if not exists idx_attachments_tenant_id on public.attachments (tenant_id);
create index if not exists idx_billing_subscriptions_plan_id on public.billing_subscriptions (plan_id);
create index if not exists idx_brands_deleted_by on public.brands (deleted_by);
create index if not exists idx_campaign_recipients_tenant_id on public.campaign_recipients (tenant_id);
create index if not exists idx_campaign_recipients_whatsapp_message_id on public.campaign_recipients (whatsapp_message_id);
create index if not exists idx_campaigns_created_by on public.campaigns (created_by);
create index if not exists idx_campaigns_deleted_by on public.campaigns (deleted_by);
create index if not exists idx_campaigns_template_id on public.campaigns (template_id);
create index if not exists idx_campaigns_whatsapp_line_id on public.campaigns (whatsapp_line_id);
create index if not exists idx_clients_assigned_to on public.clients (assigned_to);
create index if not exists idx_clients_deleted_by on public.clients (deleted_by);
create index if not exists idx_contact_addresses_deleted_by on public.contact_addresses (deleted_by);
create index if not exists idx_conversation_tags_deleted_by on public.conversation_tags (deleted_by);
create index if not exists idx_integration_credentials_deleted_by on public.integration_credentials (deleted_by);
create index if not exists idx_integration_credentials_provider_key on public.integration_credentials (provider_key);
create index if not exists idx_notes_author_id on public.notes (author_id);
create index if not exists idx_notes_tenant_id on public.notes (tenant_id);
create index if not exists idx_opportunities_deleted_by on public.opportunities (deleted_by);
create index if not exists idx_opportunities_owner_id on public.opportunities (owner_id);
create index if not exists idx_opportunities_pipeline_id on public.opportunities (pipeline_id);
create index if not exists idx_opportunity_stage_history_changed_by on public.opportunity_stage_history (changed_by);
create index if not exists idx_opportunity_stage_history_from_stage_id on public.opportunity_stage_history (from_stage_id);
create index if not exists idx_payment_attempts_provider_key on public.payment_attempts (provider_key);
create index if not exists idx_payment_invoices_deleted_by on public.payment_invoices (deleted_by);
create index if not exists idx_payment_invoices_provider_key on public.payment_invoices (provider_key);
create index if not exists idx_product_categories_deleted_by on public.product_categories (deleted_by);
create index if not exists idx_product_images_tenant_id on public.product_images (tenant_id);
create index if not exists idx_product_variants_deleted_by on public.product_variants (deleted_by);
create index if not exists idx_products_deleted_by on public.products (deleted_by);
create index if not exists idx_sales_order_comments_author_id on public.sales_order_comments (author_id);
create index if not exists idx_sales_order_comments_tenant_id on public.sales_order_comments (tenant_id);
create index if not exists idx_sales_order_items_tenant_id on public.sales_order_items (tenant_id);
create index if not exists idx_sales_order_items_warehouse_id on public.sales_order_items (warehouse_id);
create index if not exists idx_sales_order_payments_created_by on public.sales_order_payments (created_by);
create index if not exists idx_sales_order_payments_deleted_by on public.sales_order_payments (deleted_by);
create index if not exists idx_sales_orders_billing_address_id on public.sales_orders (billing_address_id);
create index if not exists idx_sales_orders_created_by on public.sales_orders (created_by);
create index if not exists idx_sales_orders_deleted_by on public.sales_orders (deleted_by);
create index if not exists idx_sales_orders_shipping_address_id on public.sales_orders (shipping_address_id);
create index if not exists idx_stock_movements_created_by on public.stock_movements (created_by);
create index if not exists idx_suppliers_deleted_by on public.suppliers (deleted_by);
create index if not exists idx_tasks_deleted_by on public.tasks (deleted_by);
create index if not exists idx_tenant_enabled_modules_enabled_by on public.tenant_enabled_modules (enabled_by);
create index if not exists idx_tenant_payment_credentials_deleted_by on public.tenant_payment_credentials (deleted_by);
create index if not exists idx_tenant_payment_credentials_provider_key on public.tenant_payment_credentials (provider_key);
create index if not exists idx_warehouses_deleted_by on public.warehouses (deleted_by);
create index if not exists idx_whatsapp_message_templates_created_by on public.whatsapp_message_templates (created_by);
create index if not exists idx_whatsapp_message_templates_deleted_by on public.whatsapp_message_templates (deleted_by);
create index if not exists idx_whatsapp_messages_sender_profile_id on public.whatsapp_messages (sender_profile_id);

-- =====================================================================
-- PARTE 2: auth_rls_initplan -- envolver auth.uid() en (select ...) para
-- que Postgres lo evalúe una vez por query en vez de una vez por fila.
-- Misma lógica, distinta forma de evaluarla.
-- =====================================================================

drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select
  using (
    (id = (select auth.uid()))
    or (tenant_id = auth_tenant_id())
    or is_superadmin()
  );

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles
  for update
  using (
    (id = (select auth.uid()))
    or is_superadmin()
    or (is_tenant_admin() and (tenant_id = auth_tenant_id()))
  )
  with check (
    (id = (select auth.uid()))
    or is_superadmin()
    or (is_tenant_admin() and (tenant_id = auth_tenant_id()))
  );

drop policy if exists whatsapp_messages_insert_agent_reply on public.whatsapp_messages;
create policy whatsapp_messages_insert_agent_reply on public.whatsapp_messages
  for insert
  with check (
    (sender_type::text = 'agent'::text)
    and (sender_profile_id = (select auth.uid()))
    and (direction::text = 'outbound'::text)
    and (
      is_superadmin()
      or exists (
        select 1 from whatsapp_conversations c
        where c.id = whatsapp_messages.conversation_id
          and c.tenant_id = auth_active_tenant_id()
      )
    )
  );

drop policy if exists notes_insert on public.notes;
create policy notes_insert on public.notes
  for insert
  with check (
    ((tenant_id = auth_active_tenant_id()) or is_superadmin())
    and ((author_id = (select auth.uid())) or (author_id is null))
  );

-- =====================================================================
-- PARTE 3: multiple_permissive_policies -- consolidar policies que se
-- superponen en la misma acción/rol (Postgres evalúa TODAS las permissive
-- que aplican y las OR-ea, así que dos policies redundantes son doble
-- costo por fila sin dar más acceso que una sola bien escrita).
-- =====================================================================

-- Patrón A: una policy `FOR ALL` de superadmin solapaba con una policy
-- `FOR SELECT` ya existente que también contempla is_superadmin() -- el
-- superadmin ya tiene SELECT cubierto por la policy de select, así que la
-- de ALL se reduce a insert/update/delete.
do $$
declare
  t text;
  tables text[] := array[
    'ai_assistant_skills', 'ai_skills', 'billing_plans', 'billing_subscriptions',
    'integration_providers', 'payment_invoice_items', 'payment_invoices',
    'payment_providers', 'tenant_enabled_modules'
  ];
begin
  foreach t in array tables loop
    execute format('drop policy if exists %I_superadmin_write on public.%I', t, t);
    execute format(
      'create policy %I_superadmin_insert on public.%I for insert to authenticated with check (is_superadmin())',
      t, t
    );
    execute format(
      'create policy %I_superadmin_update on public.%I for update to authenticated using (is_superadmin()) with check (is_superadmin())',
      t, t
    );
    execute format(
      'create policy %I_superadmin_delete on public.%I for delete to authenticated using (is_superadmin())',
      t, t
    );
  end loop;
end $$;

-- Patrón B: dos policies `FOR ALL` (superadmin + tenant_admin) que ya se
-- solapaban entre sí en las 4 acciones, y además con la policy de select.
-- Se fusiona la condición en una sola policy por acción no-select.
do $$
declare
  t text;
  tables text[] := array['integration_credentials', 'tenant_payment_credentials'];
  cond text := 'is_superadmin() or (is_tenant_admin() and (tenant_id = auth_active_tenant_id()))';
begin
  foreach t in array tables loop
    execute format('drop policy if exists %I_superadmin_write on public.%I', t, t);
    execute format('drop policy if exists %I_tenant_admin_write on public.%I', t, t);
    execute format(
      'create policy %I_write_insert on public.%I for insert to authenticated with check (%s)',
      t, t, cond
    );
    execute format(
      'create policy %I_write_update on public.%I for update to authenticated using (%s) with check (%s)',
      t, t, cond, cond
    );
    execute format(
      'create policy %I_write_delete on public.%I for delete to authenticated using (%s)',
      t, t, cond
    );
  end loop;
end $$;

-- Patrón C: product_stock tenía una policy FOR SELECT con la misma
-- condición exacta que la FOR ALL de escritura -- pura redundancia, se
-- borra la de select (la de ALL ya cubre lectura con la misma lógica).
drop policy if exists product_stock_select on public.product_stock;

-- Patrón D: dos policies FOR UPDATE (superadmin + dueño) sobre la misma
-- tabla -- se fusionan en una sola con OR.
drop policy if exists tenants_self_update on public.tenants;
drop policy if exists tenants_superadmin_update on public.tenants;
create policy tenants_update on public.tenants
  for update
  using (is_superadmin() or ((id = auth_tenant_id()) and is_tenant_admin()))
  with check (is_superadmin() or ((id = auth_tenant_id()) and is_tenant_admin()));

drop policy if exists whatsapp_lines_superadmin_update on public.whatsapp_lines;
drop policy if exists whatsapp_lines_tenant_update on public.whatsapp_lines;
create policy whatsapp_lines_update on public.whatsapp_lines
  for update
  using (is_superadmin() or (tenant_id = auth_active_tenant_id()))
  with check (is_superadmin() or (tenant_id = auth_active_tenant_id()));
