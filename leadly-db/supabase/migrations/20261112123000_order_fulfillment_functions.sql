-- F1 / S1.4-5 — save_cart_lines con las claves nuevas, y los dos triggers de
-- confirmación de venta reescritos EN LA MISMA MIGRACIÓN (apply_sales_order_
-- confirmed_effects traga errores con `exception when others`: un cambio
-- desalineado entre las dos funciones dejaría de reservar facturas sin ruido).
--
-- Cada función es copia literal de su última versión:
--   * save_cart_lines ............ 20261026120000_stock_reservations.sql:481
--   * guard_sales_order_confirmation  20261111035715_client_billing_profile.sql:60
--   * apply_sales_order_confirmed_effects  20261015130000_tenant_fiscal_identity_out_of_dian_profile.sql:46
-- (verificado con grep: no hay redefiniciones posteriores de ninguna de las tres).

-- ---------------------------------------------------------------------------
-- 1. save_cart_lines: claves nuevas fulfillment_method y billing_profile_id
-- ---------------------------------------------------------------------------
-- Claves ausentes no tocan; null explícito sí pone null (billing_profile_id) o
-- viola NOT NULL (fulfillment_method: falla ruidoso, no se ignora).
create or replace function public.save_cart_lines(
  p_cart_id uuid,
  p_tenant_id uuid,
  p_patch jsonb,
  p_items jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_patch jsonb := coalesce(p_patch, '{}'::jsonb);
  v_items jsonb := coalesce(p_items, '[]'::jsonb);
  v_result jsonb;
begin
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'p_items debe ser un arreglo JSON.';
  end if;

  select c.status
    into v_status
    from public.carts c
   where c.id = p_cart_id
     and c.tenant_id = p_tenant_id
     for update;

  if not found then
    raise exception 'Carrito no encontrado.' using errcode = 'LX404';
  end if;
  if v_status <> 'open' then
    raise exception 'Este carrito ya no está abierto.' using errcode = 'LX409';
  end if;

  update public.carts c
     set contact_id = case when v_patch ? 'contact_id' then (v_patch ->> 'contact_id')::uuid else c.contact_id end,
         opportunity_id = case when v_patch ? 'opportunity_id' then (v_patch ->> 'opportunity_id')::uuid else c.opportunity_id end,
         notes = case when v_patch ? 'notes' then v_patch ->> 'notes' else c.notes end,
         valid_until = case when v_patch ? 'valid_until' then (v_patch ->> 'valid_until')::date else c.valid_until end,
         shipping_address_id = case when v_patch ? 'shipping_address_id' then (v_patch ->> 'shipping_address_id')::uuid else c.shipping_address_id end,
         billing_address_id = case when v_patch ? 'billing_address_id' then (v_patch ->> 'billing_address_id')::uuid else c.billing_address_id end,
         fulfillment_method = case when v_patch ? 'fulfillment_method' then v_patch ->> 'fulfillment_method' else c.fulfillment_method end,
         billing_profile_id = case when v_patch ? 'billing_profile_id' then (v_patch ->> 'billing_profile_id')::uuid else c.billing_profile_id end,
         shipping = case when v_patch ? 'shipping' then (v_patch ->> 'shipping')::numeric else c.shipping end,
         pos_point_id = case when v_patch ? 'pos_point_id' then (v_patch ->> 'pos_point_id')::uuid else c.pos_point_id end,
         label = case when v_patch ? 'label' then v_patch ->> 'label' else c.label end,
         last_activity_at = now()
   where c.id = p_cart_id
     and c.tenant_id = p_tenant_id;

  perform set_config('lexy.skip_reservation_sync', 'on', true);

  delete from public.cart_items i where i.cart_id = p_cart_id;

  insert into public.cart_items (
    cart_id, product_id, variant_id, warehouse_id, product_name, sku,
    quantity, unit_price, discount_amount, created_at
  )
  select p_cart_id, x.product_id, x.variant_id, x.warehouse_id, x.product_name, x.sku,
         x.quantity, x.unit_price, coalesce(x.discount_amount, 0), clock_timestamp()
    from rows from (
           jsonb_to_recordset(v_items) as (
             product_id uuid, variant_id uuid, warehouse_id uuid, product_name text, sku text,
             quantity numeric, unit_price numeric, discount_amount numeric
           )
         ) with ordinality as x(
           product_id, variant_id, warehouse_id, product_name, sku,
           quantity, unit_price, discount_amount, ord
         )
   order by x.ord;

  perform set_config('lexy.skip_reservation_sync', 'off', true);

  -- Reserva atómica (LX422 si no alcanza -> rollback de todo lo anterior).
  perform public.sync_cart_reservations(p_cart_id);

  select to_jsonb(c) || jsonb_build_object(
           'items',
           coalesce(
             (select jsonb_agg(to_jsonb(i) order by i.created_at, i.id)
                from public.cart_items i
               where i.cart_id = c.id),
             '[]'::jsonb
           )
         )
    into v_result
    from public.carts c
   where c.id = p_cart_id;

  return v_result;
end;
$$;

comment on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) is
  'Guarda de forma atómica la cabecera (solo claves presentes en p_patch), reemplaza las líneas de un carrito abierto y reserva el stock (LX422 si no alcanza). Solo service_role.';

revoke execute on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_cart_lines(uuid, uuid, jsonb, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 2. guard_sales_order_confirmation
-- ---------------------------------------------------------------------------
-- Cambios respecto de 20261111035715:
--   * El salto de POS queda SOLO para el chequeo de stock/insumos (explícito:
--     create-order / pos-checkout ya validan con findStockShortfalls).
--   * La dirección de envío se exige únicamente si fulfillment_method =
--     'delivery' (antes: todo canal salvo POS). POS es siempre 'on_site'
--     (trigger force_pos_on_site), así que sigue sin exigirla.
--   * Con envío: se acepta la dirección guardada (shipping_address_id o la
--     predeterminada del cliente) o, sin dirección, un shipping_snapshot ya
--     provisto con line1 (destino puntual). Con dirección, shipping_snapshot
--     se CONGELA aquí (BEFORE UPDATE: se escribe en la misma fila).
create or replace function public.guard_sales_order_confirmation()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_item record;
  v_physical numeric;
  v_reserved numeric;
  v_available numeric;
  v_address_id uuid;
  v_addr record;
  v_items jsonb;
  v_mat uuid;
  v_short record;
begin
  if new.sales_channel is distinct from 'pos' then
    for v_item in
      select soi.product_id, soi.variant_id, soi.product_name, soi.quantity
      from public.sales_order_items soi
      join public.products p on p.id = soi.product_id
      where soi.order_id = new.id and soi.product_id is not null and p.track_inventory = true
        and p.inventory_mode = 'stock'
      order by soi.product_id, soi.variant_id nulls first
    loop
      perform pg_advisory_xact_lock(
        hashtextextended(new.tenant_id::text || ':' || v_item.product_id::text || ':' || coalesce(v_item.variant_id::text, ''), 0)
      );

      if v_item.variant_id is not null then
        select coalesce(sum(quantity), 0) into v_physical
        from public.product_stock
        where tenant_id = new.tenant_id and variant_id = v_item.variant_id;
      else
        select coalesce(sum(quantity), 0) into v_physical
        from public.product_stock
        where tenant_id = new.tenant_id and product_id = v_item.product_id;
      end if;

      select coalesce(sum(r.quantity), 0) into v_reserved
      from public.stock_reservations r
      where r.tenant_id = new.tenant_id
        and r.product_id = v_item.product_id
        and (v_item.variant_id is null or r.variant_id is not distinct from v_item.variant_id)
        and (r.expires_at is null or r.expires_at > now())
        and (new.cart_id is null or r.cart_id <> new.cart_id);

      v_available := v_physical - v_reserved;

      if v_available < v_item.quantity then
        raise exception 'INSUFFICIENT_STOCK: Stock insuficiente para confirmar "%": disponible %, pedido %.', v_item.product_name, greatest(0, v_available), v_item.quantity;
      end if;
    end loop;

    -- Insumos de los productos 'recipe' (después de los productos: mismo orden
    -- de locks que sync_cart_reservations).
    select coalesce(jsonb_agg(jsonb_build_object('product_id', soi.product_id, 'quantity', soi.quantity)), '[]'::jsonb)
      into v_items
      from public.sales_order_items soi
     where soi.order_id = new.id and soi.product_id is not null;

    for v_mat in
      select distinct d.material_id from public.recipe_demand_lines(new.tenant_id, v_items) d order by 1
    loop
      perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text || ':m:' || v_mat::text, 0));
    end loop;

    select * into v_short
      from public.recipe_shortfalls(new.tenant_id, v_items, new.cart_id)
     order by product_id, material_id
     limit 1;
    if found then
      if v_short.material_id is null then
        raise exception 'INSUFFICIENT_STOCK: El producto "%" no tiene ficha técnica y no se puede confirmar.', v_short.product_name;
      end if;
      raise exception 'INSUFFICIENT_STOCK: Insumo insuficiente para confirmar "%": "%" disponible % %, requerido % %.',
        v_short.product_name, v_short.material_name, v_short.material_available, v_short.unit, v_short.material_required, v_short.unit;
    end if;
  end if;

  -- Destino de entrega: solo cuando el pedido se envía.
  if new.fulfillment_method = 'delivery' then
    -- Un destino de un solo uso (shipping_snapshot con line1 y sin dirección de
    -- la libreta) se respeta tal cual: NO se reemplaza por la predeterminada.
    if new.shipping_address_id is null and coalesce(btrim(new.shipping_snapshot ->> 'line1'), '') = '' then
      select id into v_address_id
      from public.contact_addresses
      where tenant_id = new.tenant_id and contact_id = new.contact_id and is_shipping = true and deleted_at is null
        and line1 is not null and line1 !~* 'no registrad|sin direcci[oó]n|pendiente|desconocid|por definir|n/a|\yna\y'
      order by is_default desc, created_at desc
      limit 1;
      if v_address_id is not null then
        new.shipping_address_id := v_address_id;
      elsif coalesce(btrim(new.shipping_snapshot ->> 'line1'), '') = '' then
        raise exception 'SHIPPING_ADDRESS_REQUIRED: El pedido no tiene dirección de envío y el contacto no tiene ninguna guardada.';
      end if;
    end if;

    -- Congelar el destino: copia de la dirección tal como está al confirmar.
    if new.shipping_address_id is not null then
      select a.id, a.recipient_name, a.phone, a.line1, a.line2, a.city, a.state_province,
             a.country, a.postal_code, a.city_code, a.state_code, a.notes
        into v_addr
        from public.contact_addresses a
       where a.id = new.shipping_address_id and a.tenant_id = new.tenant_id;
      if found then
        new.shipping_snapshot := jsonb_build_object(
          'address_id', v_addr.id,
          'recipient_name', v_addr.recipient_name,
          'phone', v_addr.phone,
          'line1', v_addr.line1,
          'line2', v_addr.line2,
          'city', v_addr.city,
          'state_province', v_addr.state_province,
          'country', v_addr.country,
          'postal_code', v_addr.postal_code,
          'city_code', v_addr.city_code,
          'state_code', v_addr.state_code,
          'notes', v_addr.notes,
          'frozen_at', now()
        );
      end if;
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.guard_sales_order_confirmation() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. apply_sales_order_confirmed_effects
-- ---------------------------------------------------------------------------
-- Cambio: el comprador del snapshot de factura sale del PERFIL DE FACTURACIÓN
-- (billing_profile_id del pedido o, si es null, el predeterminado del cliente).
-- SIN respaldo desde clients: un cliente sin perfil queda bloqueado con
-- "perfil de facturación"; el Consumidor Final (walk-in) usa el documento
-- 222222222222, ignora el perfil predeterminado y queda bloqueado por
-- "correo de facturación" hasta que llegue el correo del comprobante (TS).
-- Es una reserva: sendInvoiceToDian vuelve a armar el snapshot desde TS
-- (refreshInvoiceSnapshot) antes de transmitir, así que esta copia SQL solo
-- decide el estado inicial (pending / blocked_missing_buyer_data) y lo que
-- muestra la tarjeta de factura. Las reglas de "falta" replican a
-- buildFiscalBuyer (menos el dígito de verificación del NIT, que valida TS).
create or replace function public.apply_sales_order_confirmed_effects()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_pipeline_id uuid;
  v_won_stage_id uuid;
  v_credential_id uuid;
  v_client record;
  v_address record;
  v_bp record;
  v_use_bp boolean := false;
  v_bp_address jsonb;
  v_tenant record;
  v_profile record;
  v_city_name text;
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
      select id, full_name, phone, document_number, dian_document_type_code, is_walk_in
        into v_client
        from public.clients where id = new.contact_id;

      -- Perfil de facturación: el elegido en el pedido o el predeterminado.
      if new.billing_profile_id is not null and not coalesce(v_client.is_walk_in, false) then
        select * into v_bp from public.client_billing_profiles
         where id = new.billing_profile_id and tenant_id = new.tenant_id;
        v_use_bp := found;
      end if;
      -- El perfil PREDETERMINADO es solo para clientes con identidad propia: el
      -- Consumidor Final (walk-in) ignora todo perfil (ni el predeterminado ni uno
      -- elegido; la base ni siquiera permite crearlos bajo un walk-in): su comprador sale solo de su identidad
      -- (222222222222) + el correo de cada comprobante, que pone TS al enviar.
      if not v_use_bp and not coalesce(v_client.is_walk_in, false) then
        select * into v_bp from public.client_billing_profiles
         where tenant_id = new.tenant_id and client_id = new.contact_id
           and is_default and deleted_at is null;
        v_use_bp := found;
      end if;

      v_missing := '{}';
      if v_use_bp then
        if nullif(btrim(v_bp.legal_name), '') is null then v_missing := array_append(v_missing, 'nombre legal o razón social'); end if;
        if v_bp.document_type_code is null then v_missing := array_append(v_missing, 'tipo de documento del cliente'); end if;
        if nullif(btrim(v_bp.document_number), '') is null then v_missing := array_append(v_missing, 'número de documento del cliente');
        elsif v_bp.document_type_code = '31'
              and replace(replace(btrim(v_bp.document_number), '.', ''), ' ', '') !~ '^[0-9]{1,15}(-[0-9])?$' then
          v_missing := array_append(v_missing, 'NIT válido');
        end if;
        if nullif(btrim(v_bp.email), '') is null then v_missing := array_append(v_missing, 'correo de facturación');
        elsif btrim(v_bp.email) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then v_missing := array_append(v_missing, 'correo de facturación válido');
        end if;

        if v_bp.address_line1 is not null or v_bp.country is not null or v_bp.city is not null then
          if nullif(btrim(v_bp.address_line1), '') is null then v_missing := array_append(v_missing, 'dirección fiscal'); end if;
          if v_bp.country is null or v_bp.country = 'OT' then v_missing := array_append(v_missing, 'país de la dirección fiscal'); end if;
          if v_bp.country = 'CO' and (v_bp.city_code is null or v_bp.state_code is null) then
            v_missing := array_append(v_missing, 'departamento y municipio de la dirección fiscal');
          end if;
          v_bp_address := jsonb_build_object(
            'line1', v_bp.address_line1, 'line2', v_bp.address_line2, 'country', v_bp.country,
            'city', v_bp.city, 'state_province', v_bp.state_province,
            'city_code', v_bp.city_code, 'state_code', v_bp.state_code
          );
        else
          v_bp_address := null;
        end if;

        v_buyer_snapshot := jsonb_build_object(
          'client_id', v_client.id,
          'billing_profile_id', v_bp.id,
          'document_type_code', v_bp.document_type_code,
          'document_number', v_bp.document_number,
          'full_name', v_bp.legal_name,
          'email', v_bp.email,
          'phone', coalesce(v_bp.phone, v_client.phone),
          'applies_withholding', v_bp.applies_withholding,
          'organization_type', v_bp.organization_type,
          'tax_level_code', v_bp.tax_level_code,
          'tax_scheme_code', v_bp.tax_scheme_code,
          'address', v_bp_address
        );
      elsif coalesce(v_client.is_walk_in, false) then
        -- Consumidor Final sin perfil: documento oficial y SIN correo. El correo
        -- NUNCA sale de la ficha compartida del walk-in (clients.email): llega
        -- por comprobante (invoice_email) al enviar. Hasta entonces la factura
        -- queda bloqueada por "correo de facturación" (igual que buildFiscalBuyer).
        v_missing := array_append(v_missing, 'correo de facturación');
        v_buyer_snapshot := jsonb_build_object(
          'client_id', v_client.id,
          'document_type_code', coalesce(case when v_client.document_number is not null then v_client.dian_document_type_code end, '13'),
          'document_number', coalesce(v_client.document_number, '222222222222'),
          'full_name', coalesce(nullif(btrim(v_client.full_name), ''), 'Consumidor final'),
          'email', null,
          'phone', null,
          'applies_withholding', false,
          'organization_type', '2',
          'tax_level_code', 'R-99-PN',
          'address', null
        );
      else
        -- Cliente con identidad propia y SIN perfil: no hay respaldo desde
        -- clients (ni documento, ni correo, ni teléfono). Se bloquea con el
        -- mismo faltante que buildFiscalBuyer.
        v_missing := array_append(v_missing, 'perfil de facturación');
        v_buyer_snapshot := jsonb_build_object(
          'client_id', v_client.id,
          'document_type_code', null,
          'document_number', null,
          'full_name', null,
          'email', null,
          'phone', null,
          'applies_withholding', false,
          'address', null
        );
      end if;

      select legal_name, document_type, document_number, country, state_province, billing_address,
             fiscal_regime, is_self_withholding_agent, city_code, state_code
        into v_tenant from public.tenants where id = new.tenant_id;
      select resolution_number, resolution_prefix,
             resolution_range_from, resolution_range_to, resolution_valid_from, resolution_valid_until, software_id
        into v_profile from public.tenant_dian_profile where tenant_id = new.tenant_id;
      select name into v_city_name from public.cities where code = v_tenant.city_code;

      v_seller_snapshot := jsonb_build_object(
        'tenant_id', new.tenant_id,
        'legal_name', v_tenant.legal_name,
        'document_type', v_tenant.document_type,
        'document_number', v_tenant.document_number,
        'fiscal_regime', v_tenant.fiscal_regime,
        'is_self_withholding_agent', coalesce(v_tenant.is_self_withholding_agent, false),
        'city', v_city_name,
        'city_code', v_tenant.city_code,
        'state_code', v_tenant.state_code,
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
$function$;

-- ACL: create or replace conserva la existente (revoke ... from public de 20260903180100); no se toca.
