-- La identidad fiscal del tenant vive en el tenant, no en la integración
-- (2026-10-15, corrección explícita del usuario).
--
-- `tenant_dian_profile` es la configuración PROPIA de la emisión (resolución,
-- consecutivos, software, set de pruebas, URL del web service). Régimen
-- fiscal, autorretenedor y ciudad/departamento describen al tenant como
-- contribuyente y como contacto: son datos del tenant, igual que su razón
-- social o su NIT, y no deben depender de que exista una integración.
--
-- Esta migración es el PASO 1 y es aditiva: no borra nada. Los pasos siguientes
-- (en otro archivo, DESPUÉS de desplegar las funciones que ahora leen de
-- `tenants`) retiran de `tenant_dian_profile` las columnas fiscal_regime,
-- is_self_withholding_agent, city, city_code y state_code.
--
-- `tenants.city_code`/`state_code` ya existen y fueron cargados desde el
-- perfil DIAN en 20261015120000; el nombre de la ciudad deja de duplicarse
-- (se resuelve por JOIN al catálogo `cities`).

alter table public.tenants add column if not exists fiscal_regime text;
alter table public.tenants add column if not exists is_self_withholding_agent boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_fiscal_regime_check') then
    alter table public.tenants add constraint tenants_fiscal_regime_check
      check (fiscal_regime is null or fiscal_regime in ('responsable_iva', 'no_responsable_iva'));
  end if;
end $$;

comment on column public.tenants.fiscal_regime is 'Régimen fiscal del tenant como contribuyente (responsable_iva | no_responsable_iva). Antes vivía en tenant_dian_profile.';
comment on column public.tenants.is_self_withholding_agent is 'El tenant es autorretenedor (se emite como O-15 en la factura). Antes vivía en tenant_dian_profile.';

-- Backfill desde el perfil DIAN (solo donde el tenant aún no tiene valor).
update public.tenants t
   set fiscal_regime = p.fiscal_regime,
       is_self_withholding_agent = p.is_self_withholding_agent
  from public.tenant_dian_profile p
 where p.tenant_id = t.id and p.deleted_at is null
   and t.fiscal_regime is null;

-- Segunda copia del armado del vendedor (la primera es
-- _shared/invoicing/queueInvoiceGeneration.ts): al confirmar una venta se
-- reserva la factura con un snapshot. Pasa a leer identidad fiscal y ciudad
-- de `tenants`; de `tenant_dian_profile` solo lee resolución y software.
-- Además incluye city_code/state_code, que la copia en SQL no traía.
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
      select id, full_name, email, phone, document_number, dian_document_type_code, applies_withholding
        into v_client
        from public.clients where id = new.contact_id;

      select line1, line2, city, state_province, country, tax_id
        into v_address
        from public.contact_addresses where id = new.billing_address_id;

      v_missing := '{}';
      if v_client.dian_document_type_code is null then v_missing := array_append(v_missing, 'tipo de documento del cliente'); end if;
      if v_client.document_number is null then v_missing := array_append(v_missing, 'número de documento del cliente'); end if;

      select legal_name, document_type, document_number, country, state_province, billing_address,
             fiscal_regime, is_self_withholding_agent, city_code, state_code
        into v_tenant from public.tenants where id = new.tenant_id;
      select resolution_number, resolution_prefix,
             resolution_range_from, resolution_range_to, resolution_valid_from, resolution_valid_until, software_id
        into v_profile from public.tenant_dian_profile where tenant_id = new.tenant_id;
      select name into v_city_name from public.cities where code = v_tenant.city_code;

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
