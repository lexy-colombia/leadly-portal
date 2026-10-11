-- Copia de las facturas/notas crédito ya generadas en public.sales_* hacia el
-- esquema aislado `invoicing` (S1 de feature_invoicing_api, 2026-10-09).
--
-- ES UNA COPIA. No hace DELETE/UPDATE/DROP sobre ninguna tabla de `public`:
-- sales_invoices, sales_invoice_items, sales_invoice_withholdings,
-- sales_credit_notes, sales_document_emails y tenant_dian_profile quedan
-- intactas y el motor actual de Leadly sigue usándolas (estrangulamiento).
--
-- ALCANCE (ver progress/S1_report.md §3):
--   * sales_invoices con status NOT IN ('pending','blocked_missing_buyer_data')
--     = todo lo transmitido o con huella fiscal (accepted, sent, rejected,
--     error y los intermedios generating/generated/sending), MÁS cualquier
--     factura referenciada por una nota crédito o con un correo de entrega
--     registrado (huella aunque su estado sea otro).
--   * sus sales_invoice_items y sales_invoice_withholdings.
--   * TODAS las sales_credit_notes.
--   * sales_document_emails de los documentos migrados.
--   * NO se migran las facturas 'pending' ni 'blocked_missing_buyer_data'
--     sin huella: son borradores de Leadly, no documentos generados; siguen
--     en public y las reserva/recalcula el motor actual.
--   * NO se copia NINGÚN secreto: solo referencias en issuer_secret_refs.
--
-- ATOMICIDAD: toda la copia + la verificación es UN solo statement (un bloque
-- DO). Si la verificación final no cuadra, RAISE EXCEPTION revierte TODO,
-- sin importar cómo el cliente ejecute la migración.
--
-- IDEMPOTENCIA: cada insert usa on conflict (...) do nothing / not exists.
-- Re-ejecutar no duplica nada. Un re-run NO sincroniza filas legacy que
-- cambiaron después de la primera copia (la verificación lo detectará y
-- abortará): una resincronización requiere una decisión explícita.
--
-- Requiere 20261009180000 (test_set_id/webservice_url) y 20261009180100.

do $backfill$
declare
  -- Instante del commit que corrigió la hora de emisión a la hora de pared
  -- de Colombia (010bab9, 2026-09-10 14:52:16 -05). Antes de él, los
  -- emisores declaraban la fecha UTC y la hora UTC rotulada "-05:00".
  c_fix_cutoff constant timestamptz := timestamptz '2026-09-10 14:52:16-05';
  -- Ventana tras el commit en que el despliegue pudo no haber ocurrido aún.
  c_deploy_window constant interval := interval '24 hours';

  v_missing text;
  v_report text := '';
  rec record;
  v_n bigint;
begin
  -- -----------------------------------------------------------------------
  -- 0a. El rol que ejecuta NO debe estar sujeto a RLS sobre las tablas
  -- legacy: con RLS vería 0 filas, copiaría 0 y la verificación "cuadraría"
  -- 0 = 0. Bypassa RLS un superusuario, un rol con BYPASSRLS, o el dueño de
  -- la tabla si la tabla no tiene FORCE ROW LEVEL SECURITY.
  -- -----------------------------------------------------------------------
  select string_agg(c.relname, ', ') into v_missing
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
  where c.relname in ('sales_invoices', 'sales_invoice_items', 'sales_invoice_withholdings',
                      'sales_credit_notes', 'sales_document_emails', 'tenant_dian_profile',
                      'tenants', 'integration_credentials', 'integration_credential_secrets')
    and c.relkind = 'r'
    and c.relrowsecurity
    and not exists (select 1 from pg_roles r where r.rolname = current_user and (r.rolsuper or r.rolbypassrls))
    and (c.relforcerowsecurity or pg_get_userbyid(c.relowner) <> current_user);
  if v_missing is not null then
    raise exception 'S1 backfill: el rol % está sujeto a RLS sobre: % . Ejecutar con un rol que bypasee RLS (postgres).',
      current_user, v_missing;
  end if;

  -- -----------------------------------------------------------------------
  -- 0. Alcance
  -- -----------------------------------------------------------------------
  create temp table s1_scope_inv on commit drop as
  select si.id
  from public.sales_invoices si
  where si.status not in ('pending', 'blocked_missing_buyer_data')
     or exists (select 1 from public.sales_credit_notes cn where cn.invoice_id = si.id)
     or exists (select 1 from public.sales_document_emails e where e.invoice_id = si.id);
  create unique index on s1_scope_inv (id);

  -- Estados que el esquema nuevo no admite pero que entrarían por "huella"
  -- (una factura blocked_missing_buyer_data con NC o correo): mensaje
  -- explícito con el id, no el CHECK genérico.
  select string_agg(si.id::text || ' (' || si.status || ')', ', ') into v_missing
  from public.sales_invoices si
  where si.id in (select id from s1_scope_inv)
    and si.status not in ('pending', 'generating', 'generated', 'sending', 'sent', 'accepted', 'rejected', 'error');
  if v_missing is not null then
    raise exception 'S1 backfill: facturas con huella (NC o correo) en un estado que invoicing no admite: %', v_missing;
  end if;

  -- (order_id, attempt_number) duplicados romperían la unicidad de
  -- idempotencia (issuer, kind, external_reference, attempt_number).
  select string_agg(order_id::text || '#' || attempt_number::text, ', ') into v_missing
  from (
    select si.order_id, si.attempt_number
    from public.sales_invoices si
    where si.id in (select id from s1_scope_inv)
    group by si.order_id, si.attempt_number
    having count(*) > 1
  ) d;
  if v_missing is not null then
    raise exception 'S1 backfill: hay (order_id, attempt_number) duplicados en sales_invoices: %', v_missing;
  end if;

  -- -----------------------------------------------------------------------
  -- 1. accounts (una por tenant con perfil DIAN o con documentos)
  -- -----------------------------------------------------------------------
  -- NIT: tenants.document_number puede traer puntos, espacios y un DV tras un
  -- guion ('901234567-8', '902.086.977'). Se separa número y DV declarado;
  -- NUNCA se concatena el DV al número.
  create temp table s1_tenants_raw on commit drop as
  select t.id as tenant_id,
         (t.id in (select tenant_id from public.sales_invoices where id in (select id from s1_scope_inv)
                   union select tenant_id from public.sales_credit_notes)) as has_docs,
         btrim(coalesce(
           nullif(btrim(t.document_number::text), ''),
           (select s.seller_snapshot ->> 'document_number'
              from public.sales_invoices s
             where s.tenant_id = t.id and s.seller_snapshot ->> 'document_number' is not null
             order by s.created_at desc limit 1),
           '')) as nit_raw
  from public.tenants t
  where t.id in (select tenant_id from public.tenant_dian_profile
                 union select tenant_id from public.sales_invoices where id in (select id from s1_scope_inv)
                 union select tenant_id from public.sales_credit_notes);

  create temp table s1_tenants on commit drop as
  select r.tenant_id, r.has_docs, r.nit_raw,
         case when c.clean ~ '^[0-9]+-[0-9]$' then split_part(c.clean, '-', 1)
              when c.clean ~ '^[0-9]+$' then c.clean
              else '' end as nit,
         case when c.clean ~ '^[0-9]+-[0-9]$' then split_part(c.clean, '-', 2)::smallint end as dv_declared
  from s1_tenants_raw r
  cross join lateral (select regexp_replace(r.nit_raw, '[.\s]', '', 'g') as clean) c;

  select string_agg(tenant_id::text || ' (' || nit_raw || ')', ', ') into v_missing
  from s1_tenants where has_docs and nit !~ '^[0-9]{5,15}$';
  if v_missing is not null then
    raise exception 'S1 backfill: tenants con documentos y sin NIT válido (tenants.document_number): %', v_missing;
  end if;

  select count(*) into v_n from s1_tenants where not has_docs and nit !~ '^[0-9]{5,15}$';
  if v_n > 0 then
    raise notice 'S1 backfill: % tenant(s) con perfil DIAN pero sin NIT válido y sin documentos: se omiten.', v_n;
  end if;
  delete from s1_tenants where nit !~ '^[0-9]{5,15}$';

  -- DV declarado que no coincide con el módulo 11: no se aborta; se guarda el
  -- declarado y el desajuste queda en issuers.legacy_profile._s1_nit y aquí.
  for rec in
    select tenant_id, nit_raw, nit, dv_declared, invoicing.nit_dv(nit) as dv_calc
    from s1_tenants where dv_declared is not null and dv_declared <> invoicing.nit_dv(nit)
  loop
    raise notice 'S1 NIT: tenant % document_number=% declara DV % pero el módulo 11 da % para %',
      rec.tenant_id, rec.nit_raw, rec.dv_declared, rec.dv_calc, rec.nit;
  end loop;

  -- El NIT que firmaron las facturas históricas (seller_snapshot) debe ser el
  -- del emisor: si difiere, solo se avisa (lo declarado histórico no se toca).
  for rec in
    select distinct st.tenant_id, st.nit, regexp_replace(si.seller_snapshot ->> 'document_number', '\D', '', 'g') as snap
    from s1_tenants st
    join public.sales_invoices si on si.tenant_id = st.tenant_id and si.id in (select id from s1_scope_inv)
    where si.seller_snapshot ->> 'document_number' is not null
      and regexp_replace(si.seller_snapshot ->> 'document_number', '\D', '', 'g') <> st.nit
      and regexp_replace(si.seller_snapshot ->> 'document_number', '\D', '', 'g')
          not in (st.nit || coalesce(st.dv_declared::text, invoicing.nit_dv(st.nit)::text))
  loop
    raise notice 'S1 NIT: tenant % NIT del emisor % difiere del seller_snapshot histórico %', rec.tenant_id, rec.nit, rec.snap;
  end loop;

  insert into invoicing.accounts (name, contact_email, legacy_tenant_id)
  select coalesce(nullif(btrim(t.legal_name::text), ''), t.name::text), t.contact_email::text, t.id
  from public.tenants t
  where t.id in (select tenant_id from s1_tenants)
  on conflict (legacy_tenant_id) do nothing;

  -- -----------------------------------------------------------------------
  -- 2. issuers
  -- -----------------------------------------------------------------------
  insert into invoicing.issuers (
    account_id, status, engine, nit, dv, legal_name, document_type_code,
    fiscal_regime, is_self_withholding_agent, address, city_name, city_code,
    state_name, state_code, country_code, contact_email, contact_phone,
    environment, software_id, software_provider_nit, test_set_id, webservice_url,
    legacy_profile, legacy_tenant_id
  )
  select a.id, 'active', 'legacy', st.nit, coalesce(st.dv_declared, invoicing.nit_dv(st.nit)),
         coalesce(nullif(btrim(t.legal_name::text), ''), t.name::text),
         '31',
         p.fiscal_regime, coalesce(p.is_self_withholding_agent, false),
         case when t.billing_address is null then null else jsonb_build_object('line1', t.billing_address) end, p.city, p.city_code,
         t.state_province::text, p.state_code, 'CO',
         t.contact_email::text, t.contact_phone::text,
         coalesce((select c.mode from public.integration_credentials c
                    where c.tenant_id = t.id and c.provider_key = 'dian_directo' and c.deleted_at is null
                    limit 1), 'sandbox'),
         p.software_id, st.nit, p.test_set_id, p.webservice_url,
         coalesce(to_jsonb(p), '{}'::jsonb) || jsonb_build_object('_s1_nit', jsonb_build_object(
           'document_number_raw', st.nit_raw, 'nit', st.nit, 'dv_declared', st.dv_declared,
           'dv_computed', invoicing.nit_dv(st.nit),
           'dv_mismatch', st.dv_declared is not null and st.dv_declared <> invoicing.nit_dv(st.nit))),
         t.id
  from s1_tenants st
  join public.tenants t on t.id = st.tenant_id
  join invoicing.accounts a on a.legacy_tenant_id = t.id
  left join public.tenant_dian_profile p on p.tenant_id = t.id
  on conflict (legacy_tenant_id) do nothing;

  -- -----------------------------------------------------------------------
  -- 3. issuer_secret_refs: SOLO referencias. No se lee ningún valor secreto.
  -- -----------------------------------------------------------------------
  insert into invoicing.issuer_secret_refs (issuer_id, purpose, source, bucket, object_path)
  select iss.id, 'certificate_p12', 'storage', 'tenant-certificates', c.config ->> 'storage_path'
  from invoicing.issuers iss
  join public.integration_credentials c
    on c.tenant_id = iss.legacy_tenant_id and c.provider_key = 'dian_directo' and c.deleted_at is null
  where c.config ->> 'storage_path' is not null
  on conflict (issuer_id, purpose) do nothing;

  insert into invoicing.issuer_secret_refs (issuer_id, purpose, source, secret_name, legacy_credential_id)
  select iss.id, s.secret_name, 'legacy_integration_secret', s.secret_name, c.id
  from invoicing.issuers iss
  join public.integration_credentials c
    on c.tenant_id = iss.legacy_tenant_id and c.provider_key = 'dian_directo' and c.deleted_at is null
  join public.integration_credential_secrets s
    on s.credential_id = c.id and s.secret_name in ('certificate_password', 'software_pin', 'technical_key')
  on conflict (issuer_id, purpose) do nothing;

  -- -----------------------------------------------------------------------
  -- 4. resolutions
  -- -----------------------------------------------------------------------
  insert into invoicing.resolutions (
    issuer_id, document_kind, resolution_number, prefix, range_from, range_to,
    valid_from, valid_until, technical_key_ref_id, next_number, is_active
  )
  select iss.id, 'invoice', p.resolution_number, p.resolution_prefix,
         p.resolution_range_from, p.resolution_range_to,
         p.resolution_valid_from, p.resolution_valid_until,
         (select r.id from invoicing.issuer_secret_refs r where r.issuer_id = iss.id and r.purpose = 'technical_key'),
         -- Nunca menor que (último número transmitido + 1): el contador legacy
         -- avanza solo al aceptar, esto es un cinturón extra.
         greatest(
           coalesce(p.next_invoice_number, p.resolution_range_from),
           p.resolution_range_from,
           coalesce((select max(si.invoice_number) + 1
                       from public.sales_invoices si
                      where si.tenant_id = p.tenant_id and si.invoice_prefix = p.resolution_prefix
                        and si.status in ('accepted', 'sent')), p.resolution_range_from)
         ),
         (p.deleted_at is null)
  from public.tenant_dian_profile p
  join invoicing.issuers iss on iss.legacy_tenant_id = p.tenant_id
  where p.resolution_prefix is not null
    and p.resolution_range_from is not null
    and p.resolution_range_to is not null
  on conflict (issuer_id, document_kind, prefix) where is_active do nothing;

  insert into invoicing.resolutions (issuer_id, document_kind, prefix, range_from, range_to, next_number, is_active)
  select iss.id, 'credit_note', coalesce(p.credit_note_prefix, ''), 1, null,
         greatest(
           coalesce(p.next_credit_note_number, 1), 1,
           coalesce((select max(cn.credit_note_number) + 1
                       from public.sales_credit_notes cn
                      where cn.tenant_id = p.tenant_id
                        and coalesce(cn.credit_note_prefix, '') = coalesce(p.credit_note_prefix, '')
                        and cn.status in ('accepted', 'sent')), 1)
         ),
         (p.deleted_at is null)
  from public.tenant_dian_profile p
  join invoicing.issuers iss on iss.legacy_tenant_id = p.tenant_id
  on conflict (issuer_id, document_kind, prefix) where is_active do nothing;

  -- -----------------------------------------------------------------------
  -- 4b. Fecha/hora declaradas (issue_date_co / issue_time_co), UNA sola vez.
  -- Antes del commit c_fix_cutoff los emisores declaraban fecha UTC y hora UTC
  -- con sufijo -05:00; desde él, la hora de pared de Colombia
  -- (colombiaTime.ts). Pero el commit NO es el despliegue, y para un documento
  -- sin XML no hay forma de verificar qué se declaró. Regla (no se inventan
  -- horas):
  --   * sin XML conservado        -> hora NULL; fecha solo si UTC == Colombia
  --                                  (misma lectura en ambas reglas);
  --                                  fuente 'derived_unverified_no_xml'
  --   * con XML, antes del corte  -> UTC (derived_utc_pre_fix)
  --   * con XML, dentro de las 24 h siguientes al corte (ventana de despliegue)
  --                               -> hora NULL, fecha solo si coincide;
  --                                  fuente 'derived_unverified_window'
  --   * con XML, después          -> Colombia (derived_colombia)
  -- s1_verify_issue_dates_from_xml.ts contrasta contra el XML real y propone
  -- los UPDATE (el trigger permite derived_* -> verified_xml|corrected).
  -- -----------------------------------------------------------------------
  create temp table s1_decl on commit drop as
  with base as (
    select 'sales_invoices'::text as tbl, si.id, si.issue_date, (si.xml_storage_path is not null) as has_xml
    from public.sales_invoices si where si.id in (select id from s1_scope_inv)
    union all
    select 'sales_credit_notes', cn.id, cn.issue_date, (cn.xml_storage_path is not null)
    from public.sales_credit_notes cn
  )
  select b.tbl, b.id,
         case when b.issue_date is null then null
              when not b.has_xml or b.issue_date < c_fix_cutoff + c_deploy_window and b.issue_date >= c_fix_cutoff
                then case when (b.issue_date at time zone 'UTC')::date = (b.issue_date at time zone 'America/Bogota')::date
                          then (b.issue_date at time zone 'America/Bogota')::date end
              when b.issue_date < c_fix_cutoff then (b.issue_date at time zone 'UTC')::date
              else (b.issue_date at time zone 'America/Bogota')::date end as d,
         case when b.issue_date is null or not b.has_xml
                   or (b.issue_date >= c_fix_cutoff and b.issue_date < c_fix_cutoff + c_deploy_window) then null
              when b.issue_date < c_fix_cutoff then to_char(b.issue_date at time zone 'UTC', 'HH24:MI:SS') || '-05:00'
              else to_char(b.issue_date at time zone 'America/Bogota', 'HH24:MI:SS') || '-05:00' end as t,
         case when b.issue_date is null then null
              when not b.has_xml then 'derived_unverified_no_xml'
              when b.issue_date < c_fix_cutoff then 'derived_utc_pre_fix'
              when b.issue_date < c_fix_cutoff + c_deploy_window then 'derived_unverified_window'
              else 'derived_colombia' end as src
  from base b;
  create unique index on s1_decl (tbl, id);

  -- -----------------------------------------------------------------------
  -- 5. documents: facturas
  -- -----------------------------------------------------------------------
  insert into invoicing.documents (
    account_id, issuer_id, kind, external_reference, attempt_number, status, status_detail,
    environment, environment_is_derived, resolution_id, prefix, number, currency,
    issued_at, issue_date_co, issue_time_co, issue_datetime_source,
    buyer, seller, subtotal, tax_total, withholding_total, total,
    cufe, xml_bucket, xml_path, xml_missing, dian_tracking_id, dian_response,
    sent_at, accepted_at, rejected_at,
    legacy_source, legacy_id, legacy_tenant_id, legacy_order_id, legacy_created_by,
    created_at, updated_at
  )
  select iss.account_id, iss.id, 'invoice', si.order_id::text, si.attempt_number, si.status, si.status_detail,
         iss.environment, true,
         (select r.id from invoicing.resolutions r
           where r.issuer_id = iss.id and r.document_kind = 'invoice' and r.prefix = si.invoice_prefix
             and si.invoice_number between r.range_from and r.range_to
           limit 1),
         si.invoice_prefix, si.invoice_number, si.currency,
         si.issue_date, dc.d, dc.t, dc.src,
         si.buyer_snapshot, si.seller_snapshot, si.subtotal, si.tax_total, si.withholding_total, si.total,
         si.cufe, case when si.xml_storage_path is not null then 'sales-documents' end, si.xml_storage_path,
         (si.xml_storage_path is null and si.status in ('accepted', 'sent')),
         si.dian_tracking_id, si.dian_response,
         si.sent_at, si.accepted_at, si.rejected_at,
         'sales_invoices', si.id, si.tenant_id, si.order_id, si.created_by,
         si.created_at, si.updated_at
  from public.sales_invoices si
  join invoicing.issuers iss on iss.legacy_tenant_id = si.tenant_id
  join s1_decl dc on dc.tbl = 'sales_invoices' and dc.id = si.id
  where si.id in (select id from s1_scope_inv)
  on conflict (legacy_source, legacy_id) do nothing;

  -- -----------------------------------------------------------------------
  -- 6. documents: notas crédito (después de las facturas: referencian a una)
  -- referenced_issue_date_declared replica sendCreditNoteToDian.ts:230
  -- (String(invoice.issue_date).slice(0,10) = fecha UTC; bug BF1): es lo que
  -- EFECTIVAMENTE se declaró, no lo que debió declararse.
  -- -----------------------------------------------------------------------
  insert into invoicing.documents (
    account_id, issuer_id, kind, external_reference, attempt_number, status, status_detail,
    environment, environment_is_derived, prefix, number, currency,
    issued_at, issue_date_co, issue_time_co, issue_datetime_source,
    buyer, seller, subtotal, tax_total, withholding_total, total,
    reason_code, reason_description, tax_type_code, tax_rate,
    referenced_document_id, referenced_issue_date_declared,
    cude, xml_bucket, xml_path, xml_missing, dian_tracking_id, dian_response,
    sent_at, accepted_at, rejected_at,
    legacy_source, legacy_id, legacy_tenant_id, legacy_order_id, legacy_created_by,
    created_at, updated_at
  )
  select iss.account_id, iss.id, 'credit_note', cn.id::text, 1, cn.status, cn.status_detail,
         iss.environment, true, cn.credit_note_prefix, cn.credit_note_number, cn.currency,
         cn.issue_date, dc.d, dc.t, dc.src,
         cn.buyer_snapshot, cn.seller_snapshot, cn.subtotal, cn.tax_total, 0, cn.total,
         cn.reason_code, cn.reason_description, cn.tax_type_code, cn.tax_rate,
         ref.id,
         -- Sin issue_date propio la nota nunca llegó a declarar nada: null. Si
         -- la factura no tiene issue_date, sendCreditNoteToDian caía a la fecha
         -- de la propia nota (dc.d, que puede ser null si no es verificable).
         case when cn.issue_date is null then null
              else coalesce((inv.issue_date at time zone 'UTC')::date, dc.d) end,
         cn.cude, case when cn.xml_storage_path is not null then 'sales-documents' end, cn.xml_storage_path,
         (cn.xml_storage_path is null and cn.status in ('accepted', 'sent')),
         cn.dian_tracking_id, cn.dian_response,
         cn.sent_at, cn.accepted_at, cn.rejected_at,
         'sales_credit_notes', cn.id, cn.tenant_id, cn.order_id, cn.created_by,
         cn.created_at, cn.updated_at
  from public.sales_credit_notes cn
  join invoicing.issuers iss on iss.legacy_tenant_id = cn.tenant_id
  join public.sales_invoices inv on inv.id = cn.invoice_id
  join s1_decl dc on dc.tbl = 'sales_credit_notes' and dc.id = cn.id
  join invoicing.documents ref on ref.legacy_source = 'sales_invoices' and ref.legacy_id = cn.invoice_id
  on conflict (legacy_source, legacy_id) do nothing;

  -- -----------------------------------------------------------------------
  -- 7. items, retenciones, entregas, eventos
  -- Los guards de inmutabilidad se desactivan SOLO dentro de este statement
  -- (el DDL se revierte con él si algo falla): los documentos 'accepted' ya
  -- existen y sus hijos aún no.
  -- -----------------------------------------------------------------------
  alter table invoicing.document_items disable trigger document_items_guard_mutation;
  alter table invoicing.document_withholdings disable trigger document_withholdings_guard_mutation;

  insert into invoicing.document_items (
    document_id, display_order, description, sku, quantity, unit_price, subtotal,
    tax_type_code, tax_rate, tax_amount, taxable_base, legacy_id, legacy_order_item_id, created_at
  )
  select d.id, it.display_order, it.product_name, it.sku, it.quantity, it.unit_price, it.subtotal,
         it.tax_type_code, it.tax_rate, it.tax_amount, it.taxable_base, it.id, it.order_item_id, it.created_at
  from public.sales_invoice_items it
  join invoicing.documents d on d.legacy_source = 'sales_invoices' and d.legacy_id = it.invoice_id
  on conflict (legacy_id) do nothing;

  insert into invoicing.document_withholdings (
    document_id, tax_type_code, concept, rate, base, amount, legacy_id, created_at
  )
  select d.id, w.tax_type_code, w.concept, w.rate, w.base, w.amount, w.id, w.created_at
  from public.sales_invoice_withholdings w
  join invoicing.documents d on d.legacy_source = 'sales_invoices' and d.legacy_id = w.invoice_id
  on conflict (legacy_id) do nothing;

  alter table invoicing.document_items enable trigger document_items_guard_mutation;
  alter table invoicing.document_withholdings enable trigger document_withholdings_guard_mutation;

  insert into invoicing.document_deliveries (
    document_id, channel, recipient, subject, status, provider, provider_message_id,
    error_detail, attachments, triggered_by, legacy_id, legacy_tenant_id, legacy_created_by, created_at
  )
  select d.id, 'email', e.recipient, e.subject, e.status, e.provider, e.provider_message_id,
         e.error_detail, e.attachments, e.triggered_by, e.id, e.tenant_id, e.created_by, e.created_at
  from public.sales_document_emails e
  join invoicing.documents d
    on (d.legacy_source = 'sales_invoices' and d.legacy_id = e.invoice_id)
    or (d.legacy_source = 'sales_credit_notes' and d.legacy_id = e.credit_note_id)
  on conflict (legacy_id) do nothing;

  insert into invoicing.document_events (document_id, event_type, from_status, to_status, detail, actor, created_at)
  select d.id, 'migrated', null, d.status,
         jsonb_build_object(
           'legacy_source', d.legacy_source, 'legacy_id', d.legacy_id,
           'legacy_created_at', d.created_at, 'legacy_updated_at', d.updated_at,
           'issue_datetime_source', d.issue_datetime_source),
         'migration:20261009180200', now()
  from invoicing.documents d
  where d.legacy_source is not null
    and not exists (select 1 from invoicing.document_events e where e.document_id = d.id and e.event_type = 'migrated');

  -- -----------------------------------------------------------------------
  -- 8. VERIFICACIÓN: legacy (en alcance) vs nuevo, por tenant y estado.
  -- Cualquier diferencia aborta y revierte todo.
  -- -----------------------------------------------------------------------
  -- 8.1 facturas
  for rec in
    with l as (
      select si.tenant_id, si.status,
             count(*) n, coalesce(sum(si.total), 0) s_total, coalesce(sum(si.subtotal), 0) s_sub,
             coalesce(sum(si.tax_total), 0) s_tax,
             count(distinct si.cufe) n_cufe, count(si.xml_storage_path) n_xml, count(si.invoice_number) n_num,
             md5(string_agg(concat_ws('|', si.id, si.order_id, si.attempt_number, si.status,
                   coalesce(si.invoice_prefix, ''), coalesce(si.invoice_number::text, ''), coalesce(si.cufe, ''),
                   si.total::text, coalesce(extract(epoch from si.issue_date)::text, ''),
                   coalesce(si.xml_storage_path, ''), coalesce(si.dian_tracking_id, ''),
                   coalesce(si.status_detail, ''), coalesce(si.dian_response::text, ''),
                   coalesce(extract(epoch from si.sent_at)::text, ''), coalesce(extract(epoch from si.accepted_at)::text, ''),
                   coalesce(extract(epoch from si.rejected_at)::text, ''),
                   si.buyer_snapshot::text, si.seller_snapshot::text), ',' order by si.id)) h
      from public.sales_invoices si
      where si.id in (select id from s1_scope_inv)
      group by 1, 2
    ), n as (
      select d.legacy_tenant_id tenant_id, d.status,
             count(*) n, coalesce(sum(d.total), 0) s_total, coalesce(sum(d.subtotal), 0) s_sub,
             coalesce(sum(d.tax_total), 0) s_tax,
             count(distinct d.cufe) n_cufe, count(d.xml_path) n_xml, count(d.number) n_num,
             md5(string_agg(concat_ws('|', d.legacy_id, d.legacy_order_id, d.attempt_number, d.status,
                   coalesce(d.prefix, ''), coalesce(d.number::text, ''), coalesce(d.cufe, ''),
                   d.total::text, coalesce(extract(epoch from d.issued_at)::text, ''),
                   coalesce(d.xml_path, ''), coalesce(d.dian_tracking_id, ''),
                   coalesce(d.status_detail, ''), coalesce(d.dian_response::text, ''),
                   coalesce(extract(epoch from d.sent_at)::text, ''), coalesce(extract(epoch from d.accepted_at)::text, ''),
                   coalesce(extract(epoch from d.rejected_at)::text, ''),
                   d.buyer::text, d.seller::text), ',' order by d.legacy_id)) h
      from invoicing.documents d
      where d.legacy_source = 'sales_invoices'
      group by 1, 2
    )
    select coalesce(l.tenant_id, n.tenant_id) tenant_id, coalesce(l.status, n.status) status,
           row(l.n, l.s_total, l.s_sub, l.s_tax, l.n_cufe, l.n_xml, l.n_num, l.h)::text lv,
           row(n.n, n.s_total, n.s_sub, n.s_tax, n.n_cufe, n.n_xml, n.n_num, n.h)::text nv
    from l full join n on l.tenant_id = n.tenant_id and l.status = n.status
    where l.n is distinct from n.n or l.s_total is distinct from n.s_total or l.s_sub is distinct from n.s_sub
       or l.s_tax is distinct from n.s_tax or l.n_cufe is distinct from n.n_cufe
       or l.n_xml is distinct from n.n_xml or l.n_num is distinct from n.n_num or l.h is distinct from n.h
  loop
    v_report := v_report || format(E'\n  facturas tenant=%s status=%s legacy=%s nuevo=%s', rec.tenant_id, rec.status, rec.lv, rec.nv);
  end loop;

  -- 8.2 notas crédito
  for rec in
    with l as (
      select cn.tenant_id, cn.status,
             count(*) n, coalesce(sum(cn.total), 0) s_total, count(distinct cn.cude) n_cude,
             count(cn.xml_storage_path) n_xml, count(cn.credit_note_number) n_num,
             md5(string_agg(concat_ws('|', cn.id, cn.invoice_id, cn.status, cn.reason_code, cn.reason_description,
                   coalesce(cn.credit_note_prefix, ''), coalesce(cn.credit_note_number::text, ''),
                   coalesce(cn.cude, ''), cn.total::text, cn.subtotal::text, cn.tax_total::text,
                   coalesce(extract(epoch from cn.issue_date)::text, ''), coalesce(cn.xml_storage_path, ''),
                   coalesce(cn.status_detail, ''), coalesce(cn.dian_response::text, ''), coalesce(cn.dian_tracking_id, ''),
                   coalesce(extract(epoch from cn.sent_at)::text, ''), coalesce(extract(epoch from cn.accepted_at)::text, ''),
                   coalesce(extract(epoch from cn.rejected_at)::text, ''),
                   cn.buyer_snapshot::text, cn.seller_snapshot::text), ',' order by cn.id)) h
      from public.sales_credit_notes cn group by 1, 2
    ), n as (
      select d.legacy_tenant_id tenant_id, d.status,
             count(*) n, coalesce(sum(d.total), 0) s_total, count(distinct d.cude) n_cude,
             count(d.xml_path) n_xml, count(d.number) n_num,
             md5(string_agg(concat_ws('|', d.legacy_id, ref.legacy_id, d.status, d.reason_code, d.reason_description,
                   coalesce(d.prefix, ''), coalesce(d.number::text, ''),
                   coalesce(d.cude, ''), d.total::text, d.subtotal::text, d.tax_total::text,
                   coalesce(extract(epoch from d.issued_at)::text, ''), coalesce(d.xml_path, ''),
                   coalesce(d.status_detail, ''), coalesce(d.dian_response::text, ''), coalesce(d.dian_tracking_id, ''),
                   coalesce(extract(epoch from d.sent_at)::text, ''), coalesce(extract(epoch from d.accepted_at)::text, ''),
                   coalesce(extract(epoch from d.rejected_at)::text, ''),
                   d.buyer::text, d.seller::text), ',' order by d.legacy_id)) h
      from invoicing.documents d
      left join invoicing.documents ref on ref.id = d.referenced_document_id
      where d.legacy_source = 'sales_credit_notes' group by 1, 2
    )
    select coalesce(l.tenant_id, n.tenant_id) tenant_id, coalesce(l.status, n.status) status,
           row(l.n, l.s_total, l.n_cude, l.n_xml, l.n_num, l.h)::text lv,
           row(n.n, n.s_total, n.n_cude, n.n_xml, n.n_num, n.h)::text nv
    from l full join n on l.tenant_id = n.tenant_id and l.status = n.status
    where l.n is distinct from n.n or l.s_total is distinct from n.s_total or l.n_cude is distinct from n.n_cude
       or l.n_xml is distinct from n.n_xml or l.n_num is distinct from n.n_num or l.h is distinct from n.h
  loop
    v_report := v_report || format(E'\n  notas_credito tenant=%s status=%s legacy=%s nuevo=%s', rec.tenant_id, rec.status, rec.lv, rec.nv);
  end loop;

  -- 8.3 ítems, retenciones y entregas, por tenant
  for rec in
    with l as (
      select si.tenant_id, count(*) n, coalesce(sum(it.subtotal), 0) s_sub, coalesce(sum(it.tax_amount), 0) s_tax,
             coalesce(sum(it.taxable_base), 0) s_base, coalesce(sum(it.quantity), 0) s_qty,
             md5(string_agg(concat_ws('|', it.id, it.invoice_id, it.display_order, it.product_name, coalesce(it.sku, ''),
                   it.unit_price::text, coalesce(it.tax_type_code, ''), it.tax_rate::text), ',' order by it.id)) h
      from public.sales_invoice_items it
      join public.sales_invoices si on si.id = it.invoice_id
      where si.id in (select id from s1_scope_inv) group by 1
    ), n as (
      select d.legacy_tenant_id tenant_id, count(*) n, coalesce(sum(it.subtotal), 0) s_sub, coalesce(sum(it.tax_amount), 0) s_tax,
             coalesce(sum(it.taxable_base), 0) s_base, coalesce(sum(it.quantity), 0) s_qty,
             md5(string_agg(concat_ws('|', it.legacy_id, d.legacy_id, it.display_order, it.description, coalesce(it.sku, ''),
                   it.unit_price::text, coalesce(it.tax_type_code, ''), it.tax_rate::text), ',' order by it.legacy_id)) h
      from invoicing.document_items it
      join invoicing.documents d on d.id = it.document_id
      where d.legacy_source = 'sales_invoices' group by 1
    )
    select coalesce(l.tenant_id, n.tenant_id) tenant_id,
           row(l.n, l.s_sub, l.s_tax, l.s_base, l.s_qty, l.h)::text lv,
           row(n.n, n.s_sub, n.s_tax, n.s_base, n.s_qty, n.h)::text nv
    from l full join n on l.tenant_id = n.tenant_id
    where l.n is distinct from n.n or l.s_sub is distinct from n.s_sub or l.s_tax is distinct from n.s_tax
       or l.s_base is distinct from n.s_base or l.s_qty is distinct from n.s_qty or l.h is distinct from n.h
  loop
    v_report := v_report || format(E'\n  items tenant=%s legacy=%s nuevo=%s', rec.tenant_id, rec.lv, rec.nv);
  end loop;

  for rec in
    with l as (
      select w.tenant_id, count(*) n, coalesce(sum(w.amount), 0) s, coalesce(sum(w.base), 0) b
      from public.sales_invoice_withholdings w
      where w.invoice_id in (select id from s1_scope_inv) group by 1
    ), n as (
      select d.legacy_tenant_id tenant_id, count(*) n, coalesce(sum(w.amount), 0) s, coalesce(sum(w.base), 0) b
      from invoicing.document_withholdings w
      join invoicing.documents d on d.id = w.document_id group by 1
    )
    select coalesce(l.tenant_id, n.tenant_id) tenant_id,
           row(l.n, l.s, l.b)::text lv, row(n.n, n.s, n.b)::text nv
    from l full join n on l.tenant_id = n.tenant_id
    where l.n is distinct from n.n or l.s is distinct from n.s or l.b is distinct from n.b
  loop
    v_report := v_report || format(E'\n  retenciones tenant=%s legacy=%s nuevo=%s', rec.tenant_id, rec.lv, rec.nv);
  end loop;

  for rec in
    with l as (
      select e.tenant_id, count(*) n,
             md5(string_agg(concat_ws('|', e.id, e.recipient, e.subject, e.status, coalesce(e.provider_message_id, ''),
                   array_to_string(e.attachments, ';'), e.triggered_by), ',' order by e.id)) h
      from public.sales_document_emails e group by 1
    ), n as (
      select dl.legacy_tenant_id tenant_id, count(*) n,
             md5(string_agg(concat_ws('|', dl.legacy_id, dl.recipient, dl.subject, dl.status, coalesce(dl.provider_message_id, ''),
                   array_to_string(dl.attachments, ';'), dl.triggered_by), ',' order by dl.legacy_id)) h
      from invoicing.document_deliveries dl group by 1
    )
    select coalesce(l.tenant_id, n.tenant_id) tenant_id, row(l.n, l.h)::text lv, row(n.n, n.h)::text nv
    from l full join n on l.tenant_id = n.tenant_id
    where l.n is distinct from n.n or l.h is distinct from n.h
  loop
    v_report := v_report || format(E'\n  correos tenant=%s legacy=%s nuevo=%s', rec.tenant_id, rec.lv, rec.nv);
  end loop;

  -- Piso de conteo: si hay documentos en alcance legacy y la copia dio 0, algo
  -- (RLS, permisos) hizo que la verificación "cuadre" 0 = 0.
  select count(*) into v_n from s1_scope_inv;
  if v_n > 0 and not exists (select 1 from invoicing.documents where legacy_source = 'sales_invoices') then
    raise exception 'S1 backfill: % facturas en alcance legacy pero 0 copiadas.', v_n;
  end if;

  if v_report <> '' then
    raise exception E'S1 backfill: la verificación legacy vs invoicing NO cuadra (se revierte todo):%', v_report;
  end if;

  -- -----------------------------------------------------------------------
  -- 9. Informe (NOTICE). Nada de esto aborta.
  -- -----------------------------------------------------------------------
  for rec in
    select d.kind, d.status, count(*) n, count(*) filter (where d.xml_missing) n_xml_missing
    from invoicing.documents d where d.legacy_source is not null group by 1, 2 order by 1, 2
  loop
    raise notice 'S1 migrado: kind=% status=% n=% sin_xml=%', rec.kind, rec.status, rec.n, rec.n_xml_missing;
  end loop;

  -- Aceptadas cuya HORA (y quizá fecha) declarada NO se pudo establecer:
  -- quedan con issue_time_co null hasta verificarlas contra el XML.
  for rec in
    select d.legacy_id, d.prefix, d.number, d.issued_at, d.issue_date_co, d.issue_datetime_source
    from invoicing.documents d
    where d.legacy_source is not null and d.status in ('accepted', 'sent')
      and d.issue_datetime_source like 'derived_unverified%'
    order by d.issued_at
  loop
    raise notice 'S1 HORA SIN VERIFICAR: legacy_id=% %-% issued_at=% issue_date_co=% source=%',
      rec.legacy_id, rec.prefix, rec.number, rec.issued_at, rec.issue_date_co, rec.issue_datetime_source;
  end loop;

  -- Aceptadas con fecha UTC != Colombia y regla pre-fix: la fecha declarada es
  -- la UTC (distinta del día local).
  for rec in
    select d.legacy_id, d.number, d.prefix, d.issued_at, d.issue_date_co, d.issue_datetime_source
    from invoicing.documents d
    where d.legacy_source is not null and d.status = 'accepted'
      and d.issued_at is not null
      and (d.issued_at at time zone 'UTC')::date <> (d.issued_at at time zone 'America/Bogota')::date
      and d.issue_datetime_source in ('derived_utc_pre_fix', 'derived_unverified_window', 'derived_unverified_no_xml')
  loop
    raise notice 'S1 AMBIGUO fecha declarada (ventana nocturna, previa/cercana al fix): legacy_id=% %-% issued_at=% issue_date_co=% source=%',
      rec.legacy_id, rec.prefix, rec.number, rec.issued_at, rec.issue_date_co, rec.issue_datetime_source;
  end loop;
end
$backfill$;
