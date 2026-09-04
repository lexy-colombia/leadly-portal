-- Centraliza en triggers de DB lo que hasta ahora vivía SOLO en
-- confirmSalesOrder.ts (_shared, usado por whatsapp-ai-tools y storefront):
-- chequeo de stock, resolución/exigencia de dirección de facturación y
-- envío, mover la oportunidad vinculada a "Ganado", y reservar la factura
-- DIAN. Encontrado en vivo (2026-09-03): el botón "Confirmar" del portal
-- (Orders.tsx/OrderDetail.tsx -> updateOrderStatus) hace un UPDATE directo
-- a sales_orders sin pasar por ese código compartido -- una venta
-- confirmada a mano en el portal nunca chequeaba stock de verdad, nunca
-- movía la oportunidad, y nunca reservaba su factura. Pedido explícito del
-- usuario: la fuente de verdad no puede depender de que cada caller (IA,
-- tienda pública, portal, o el que se agregue a futuro) se acuerde de
-- invocar la lógica correcta -- tiene que aplicar sí o sí desde la base de
-- datos, sin importar qué código dispara el UPDATE.

-- 1) BEFORE UPDATE: guardia -- bloquea la transacción si falta stock o
-- dirección, y auto-completa billing/shipping_address_id desde la
-- dirección default del contacto si el caller no las mandó (mismo
-- comportamiento que getDefaultAddress/isPlaceholderAddressText en TS).
create or replace function public.guard_sales_order_confirmation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_item record;
  v_available numeric;
  v_address_id uuid;
begin
  -- Chequeo de stock (variant-aware), solo para ítems de productos con
  -- track_inventory=true -- mismo criterio que confirmSalesOrder.ts.
  for v_item in
    select soi.product_id, soi.variant_id, soi.product_name, soi.quantity
    from public.sales_order_items soi
    join public.products p on p.id = soi.product_id
    where soi.order_id = new.id and soi.product_id is not null and p.track_inventory = true
  loop
    if v_item.variant_id is not null then
      select coalesce(sum(quantity), 0) into v_available
      from public.product_stock
      where tenant_id = new.tenant_id and variant_id = v_item.variant_id;
    else
      select coalesce(sum(quantity), 0) into v_available
      from public.product_stock
      where tenant_id = new.tenant_id and product_id = v_item.product_id;
    end if;

    if v_available < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK: Stock insuficiente para confirmar "%": disponible %, pedido %.', v_item.product_name, greatest(0, v_available), v_item.quantity;
    end if;
  end loop;

  -- Dirección de facturación: usa la que ya trae el pedido, si no busca la
  -- default del contacto (saltando texto placeholder), si no bloquea.
  if new.billing_address_id is null then
    select id into v_address_id
    from public.contact_addresses
    where tenant_id = new.tenant_id and contact_id = new.contact_id and is_billing = true and deleted_at is null
      and line1 is not null and line1 !~* 'no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|n/a|\yna\y'
    order by is_default desc, created_at desc
    limit 1;
    if v_address_id is null then
      raise exception 'BILLING_ADDRESS_REQUIRED: El pedido no tiene dirección de facturación y el contacto no tiene ninguna guardada.';
    end if;
    new.billing_address_id := v_address_id;
  end if;

  -- Dirección de envío: mismo criterio.
  if new.shipping_address_id is null then
    select id into v_address_id
    from public.contact_addresses
    where tenant_id = new.tenant_id and contact_id = new.contact_id and is_shipping = true and deleted_at is null
      and line1 is not null and line1 !~* 'no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|n/a|\yna\y'
    order by is_default desc, created_at desc
    limit 1;
    if v_address_id is null then
      raise exception 'SHIPPING_ADDRESS_REQUIRED: El pedido no tiene dirección de envío y el contacto no tiene ninguna guardada.';
    end if;
    new.shipping_address_id := v_address_id;
  end if;

  return new;
end;
$$;

create trigger trg_sales_orders_confirm_guard
  before update of status on public.sales_orders
  for each row
  when (old.status = 'cotizacion' and new.status = 'confirmada')
  execute function public.guard_sales_order_confirmation();

-- 2) AFTER UPDATE: efectos best-effort -- mover la oportunidad vinculada a
-- "Ganado" y reservar la factura DIAN. Cada bloque atrapa su propia
-- excepción (mismo criterio que los try/catch de confirmSalesOrder.ts): un
-- fallo acá nunca debe deshacer una venta que ya quedó confirmada.
create or replace function public.apply_sales_order_confirmed_effects()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_pipeline_id uuid;
  v_won_stage_id uuid;
  v_credential_id uuid;
  v_client record;
  v_address record;
  v_tenant record;
  v_profile record;
  v_missing text[] := '{}';
  v_buyer_snapshot jsonb;
  v_seller_snapshot jsonb;
  v_invoice_id uuid;
begin
  -- Mover la oportunidad vinculada a "Ganado", si tiene una.
  begin
    if new.opportunity_id is not null then
      select pipeline_id into v_pipeline_id from public.opportunities where id = new.opportunity_id;
      if v_pipeline_id is not null then
        select id into v_won_stage_id
        from public.pipeline_stages
        where pipeline_id = v_pipeline_id and is_won = true
        order by display_order asc
        limit 1;
        if v_won_stage_id is not null then
          update public.opportunities set stage_id = v_won_stage_id, status = 'won' where id = new.opportunity_id;
        end if;
      end if;
    end if;
  exception when others then
    raise warning 'apply_sales_order_confirmed_effects: no se pudo mover la oportunidad % a Ganado (pedido %): %', new.opportunity_id, new.id, sqlerrm;
  end;

  -- Reservar la fila de sales_invoices si el tenant tiene 'dian_directo'
  -- activo -- mismo criterio y forma de snapshot que
  -- _shared/invoicing/queueInvoiceGeneration.ts (ver ese archivo, que ya
  -- no hace falta que lo llame ningún caller aparte, esto reemplaza esa
  -- responsabilidad para TODO caller).
  begin
    select id into v_credential_id
    from public.integration_credentials
    where tenant_id = new.tenant_id and provider_key = 'dian_directo' and is_active = true and deleted_at is null;

    if v_credential_id is not null then
      select id, full_name, email, phone, document_number, dian_document_type_code, applies_withholding
        into v_client
        from public.clients where id = new.contact_id;

      select line1, line2, city, state_province, country, tax_id
        into v_address
        from public.contact_addresses where id = new.billing_address_id;

      v_missing := '{}';
      if v_client.dian_document_type_code is null then v_missing := array_append(v_missing, 'tipo de documento del cliente'); end if;
      if v_client.document_number is null then v_missing := array_append(v_missing, 'número de documento del cliente'); end if;

      select legal_name, document_type, document_number, country, state_province, billing_address
        into v_tenant from public.tenants where id = new.tenant_id;
      select fiscal_regime, is_self_withholding_agent, city, resolution_number, resolution_prefix,
             resolution_range_from, resolution_range_to, resolution_valid_from, resolution_valid_until, software_id
        into v_profile from public.tenant_dian_profile where tenant_id = new.tenant_id;

      v_buyer_snapshot := jsonb_build_object(
        'client_id', v_client.id,
        'document_type_code', v_client.dian_document_type_code,
        'document_number', v_client.document_number,
        'full_name', v_client.full_name,
        'email', v_client.email,
        'phone', v_client.phone,
        'applies_withholding', coalesce(v_client.applies_withholding, false),
        'address', case when v_address.line1 is null then null else jsonb_build_object(
          'line1', v_address.line1, 'line2', v_address.line2, 'city', v_address.city,
          'state_province', v_address.state_province, 'country', v_address.country, 'tax_id', v_address.tax_id
        ) end
      );
      v_seller_snapshot := jsonb_build_object(
        'tenant_id', new.tenant_id,
        'legal_name', v_tenant.legal_name,
        'document_type', v_tenant.document_type,
        'document_number', v_tenant.document_number,
        'fiscal_regime', v_profile.fiscal_regime,
        'is_self_withholding_agent', coalesce(v_profile.is_self_withholding_agent, false),
        'city', v_profile.city,
        'billing_address', v_tenant.billing_address,
        'country', v_tenant.country,
        'state_province', v_tenant.state_province,
        'resolution', case when v_profile.resolution_number is null and v_profile.resolution_prefix is null then null else jsonb_build_object(
          'number', v_profile.resolution_number, 'prefix', v_profile.resolution_prefix,
          'range_from', v_profile.resolution_range_from, 'range_to', v_profile.resolution_range_to,
          'valid_from', v_profile.resolution_valid_from, 'valid_until', v_profile.resolution_valid_until
        ) end,
        'software_id', v_profile.software_id
      );

      insert into public.sales_invoices (tenant_id, order_id, status, status_detail, subtotal, tax_total, total, currency, buyer_snapshot, seller_snapshot)
      values (
        new.tenant_id, new.id,
        case when array_length(v_missing, 1) > 0 then 'blocked_missing_buyer_data' else 'pending' end,
        case when array_length(v_missing, 1) > 0 then 'Falta: ' || array_to_string(v_missing, ', ') else null end,
        new.subtotal, new.tax_total, new.total, new.currency,
        v_buyer_snapshot, v_seller_snapshot
      )
      returning id into v_invoice_id;

      insert into public.sales_invoice_items (tenant_id, invoice_id, order_item_id, product_name, sku, quantity, unit_price, subtotal, tax_type_code, tax_rate, tax_amount, taxable_base, display_order)
      select new.tenant_id, v_invoice_id, soi.id, soi.product_name, soi.sku, soi.quantity, soi.unit_price, soi.subtotal,
             soi.tax_type_code, soi.tax_rate, soi.tax_amount, soi.taxable_base, soi.display_order
      from public.sales_order_items soi
      where soi.order_id = new.id
      order by soi.display_order;
    end if;
  exception when others then
    raise warning 'apply_sales_order_confirmed_effects: no se pudo reservar la factura DIAN del pedido %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

create trigger trg_sales_orders_confirmed_effects
  after update of status on public.sales_orders
  for each row
  when (old.status = 'cotizacion' and new.status = 'confirmada')
  execute function public.apply_sales_order_confirmed_effects();
