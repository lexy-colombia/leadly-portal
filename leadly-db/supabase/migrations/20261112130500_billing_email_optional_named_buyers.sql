-- F2 ronda 5 — El correo del comprador CON NOMBRE (perfil de facturación) pasa a
-- ser OPCIONAL en el servidor: la DIAN no lo exige (FAK55 0..1; hay facturas
-- aceptadas sin cac:Contact del adquirente). La obligatoriedad es del frontend
-- al capturar el perfil.
--
-- Redefine apply_sales_order_confirmed_effects con la copia EXACTA de la
-- definición vigente (20261112123000) y SOLO cambia esto: un perfil sin correo
-- ya no agrega "correo de facturación" a los faltantes (la factura se reserva
-- `pending`). Un correo presente con formato inválido sigue faltando como
-- "correo de facturación válido". Se conservan el manejo de errores
-- (`exception when others` -> warning), search_path y la ACL de la función
-- (create or replace no la toca; 123000 no repite revoke).
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
        -- El correo del comprador es OPCIONAL (la DIAN no lo exige: FAK55 es 0..1
        -- y hay facturas aceptadas sin cac:Contact del adquirente); la captura
        -- obligatoria es del frontend. Sin correo la factura queda pending; con
        -- un correo de formato inválido sí falta "correo de facturación válido".
        if nullif(btrim(v_bp.email), '') is not null
           and btrim(v_bp.email) !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
          v_missing := array_append(v_missing, 'correo de facturación válido');
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
        -- NUNCA sale de la ficha compartida del walk-in (clients.email); si el
        -- comprador lo pide llega por comprobante (invoice_email) al enviar. Es
        -- OPCIONAL (Anexo 1.9 FAK55: para consumidor final ElectronicMail es
        -- opcional): sin correo la factura queda `pending`, no bloqueada (igual
        -- que buildFiscalBuyer).
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
