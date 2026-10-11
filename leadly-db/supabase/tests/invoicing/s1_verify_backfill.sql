-- S1 · VERIFICACIÓN POST-COPIA (SOLO LECTURA, re-ejecutable).
-- Compara public.sales_* (alcance de la copia) contra invoicing.*. Cualquier
-- fila impresa en las secciones de diferencias es una discrepancia. Útil
-- también DESPUÉS del deploy para ver cuánto "driftó" legacy mientras el motor
-- actual sigue emitiendo (estrangulamiento): filas nuevas o cambiadas en
-- legacy aparecerán como diferencias hasta que se haga una resincronización.
--   psql "$DB_URL" -f s1_verify_backfill.sql

\echo '== 1. Facturas: diferencias por tenant/estado (vacío = cuadra)'
with scope as (
  select si.id from public.sales_invoices si
  where si.status not in ('pending', 'blocked_missing_buyer_data')
     or exists (select 1 from public.sales_credit_notes cn where cn.invoice_id = si.id)
     or exists (select 1 from public.sales_document_emails e where e.invoice_id = si.id)
), l as (
  select si.tenant_id, si.status, count(*) n, coalesce(sum(si.total), 0) s_total, count(distinct si.cufe) n_cufe,
         count(si.xml_storage_path) n_xml, count(si.invoice_number) n_num,
         md5(string_agg(concat_ws('|', si.id, si.order_id, si.attempt_number, si.status,
               coalesce(si.invoice_prefix, ''), coalesce(si.invoice_number::text, ''), coalesce(si.cufe, ''),
               si.total::text, coalesce(extract(epoch from si.issue_date)::text, ''),
               coalesce(si.xml_storage_path, ''), coalesce(si.dian_tracking_id, ''),
               coalesce(si.status_detail, ''), coalesce(si.dian_response::text, ''),
               coalesce(extract(epoch from si.sent_at)::text, ''), coalesce(extract(epoch from si.accepted_at)::text, ''),
               coalesce(extract(epoch from si.rejected_at)::text, ''),
               si.buyer_snapshot::text, si.seller_snapshot::text), ',' order by si.id)) h
  from public.sales_invoices si where si.id in (select id from scope) group by 1, 2
), n as (
  select d.legacy_tenant_id tenant_id, d.status, count(*) n, coalesce(sum(d.total), 0) s_total, count(distinct d.cufe) n_cufe,
         count(d.xml_path) n_xml, count(d.number) n_num,
         md5(string_agg(concat_ws('|', d.legacy_id, d.legacy_order_id, d.attempt_number, d.status,
               coalesce(d.prefix, ''), coalesce(d.number::text, ''), coalesce(d.cufe, ''),
               d.total::text, coalesce(extract(epoch from d.issued_at)::text, ''),
               coalesce(d.xml_path, ''), coalesce(d.dian_tracking_id, ''),
               coalesce(d.status_detail, ''), coalesce(d.dian_response::text, ''),
               coalesce(extract(epoch from d.sent_at)::text, ''), coalesce(extract(epoch from d.accepted_at)::text, ''),
               coalesce(extract(epoch from d.rejected_at)::text, ''),
               d.buyer::text, d.seller::text), ',' order by d.legacy_id)) h
  from invoicing.documents d where d.legacy_source = 'sales_invoices' group by 1, 2
)
select coalesce(l.tenant_id, n.tenant_id) tenant_id, coalesce(l.status, n.status) status,
       row(l.n, l.s_total, l.n_cufe, l.n_xml, l.n_num, l.h) legacy, row(n.n, n.s_total, n.n_cufe, n.n_xml, n.n_num, n.h) nuevo
from l full join n on l.tenant_id = n.tenant_id and l.status = n.status
where l.n is distinct from n.n or l.s_total is distinct from n.s_total or l.n_cufe is distinct from n.n_cufe
   or l.n_xml is distinct from n.n_xml or l.n_num is distinct from n.n_num or l.h is distinct from n.h;

\echo '== 2. Notas crédito: diferencias por tenant/estado'
with l as (
  select cn.tenant_id, cn.status, count(*) n, coalesce(sum(cn.total), 0) s_total, count(distinct cn.cude) n_cude,
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
  select d.legacy_tenant_id tenant_id, d.status, count(*) n, coalesce(sum(d.total), 0) s_total, count(distinct d.cude) n_cude,
         count(d.xml_path) n_xml, count(d.number) n_num,
         md5(string_agg(concat_ws('|', d.legacy_id, ref.legacy_id, d.status, d.reason_code, d.reason_description,
               coalesce(d.prefix, ''), coalesce(d.number::text, ''), coalesce(d.cude, ''), d.total::text,
               d.subtotal::text, d.tax_total::text, coalesce(extract(epoch from d.issued_at)::text, ''),
               coalesce(d.xml_path, ''),
               coalesce(d.status_detail, ''), coalesce(d.dian_response::text, ''), coalesce(d.dian_tracking_id, ''),
               coalesce(extract(epoch from d.sent_at)::text, ''), coalesce(extract(epoch from d.accepted_at)::text, ''),
               coalesce(extract(epoch from d.rejected_at)::text, ''),
               d.buyer::text, d.seller::text), ',' order by d.legacy_id)) h
  from invoicing.documents d left join invoicing.documents ref on ref.id = d.referenced_document_id
  where d.legacy_source = 'sales_credit_notes' group by 1, 2
)
select coalesce(l.tenant_id, n.tenant_id) tenant_id, coalesce(l.status, n.status) status,
       row(l.n, l.s_total, l.n_cude, l.n_xml, l.n_num, l.h) legacy, row(n.n, n.s_total, n.n_cude, n.n_xml, n.n_num, n.h) nuevo
from l full join n on l.tenant_id = n.tenant_id and l.status = n.status
where l.n is distinct from n.n or l.s_total is distinct from n.s_total or l.n_cude is distinct from n.n_cude
   or l.n_xml is distinct from n.n_xml or l.n_num is distinct from n.n_num or l.h is distinct from n.h;

\echo '== 3. Ítems por tenant'
with l as (
  select si.tenant_id, count(*) n, coalesce(sum(it.subtotal), 0) s_sub, coalesce(sum(it.tax_amount), 0) s_tax,
         coalesce(sum(it.taxable_base), 0) s_base, coalesce(sum(it.quantity), 0) s_qty
  from public.sales_invoice_items it join public.sales_invoices si on si.id = it.invoice_id
  where si.id in (select legacy_id from invoicing.documents where legacy_source = 'sales_invoices') group by 1
), n as (
  select d.legacy_tenant_id tenant_id, count(*) n, coalesce(sum(it.subtotal), 0) s_sub, coalesce(sum(it.tax_amount), 0) s_tax,
         coalesce(sum(it.taxable_base), 0) s_base, coalesce(sum(it.quantity), 0) s_qty
  from invoicing.document_items it join invoicing.documents d on d.id = it.document_id
  where d.legacy_source = 'sales_invoices' group by 1
)
select coalesce(l.tenant_id, n.tenant_id) tenant_id, row(l.*) legacy, row(n.*) nuevo
from l full join n on l.tenant_id = n.tenant_id
where l.n is distinct from n.n or l.s_sub is distinct from n.s_sub or l.s_tax is distinct from n.s_tax
   or l.s_base is distinct from n.s_base or l.s_qty is distinct from n.s_qty;

\echo '== 4. Retenciones y correos por tenant'
select 'retenciones' as tabla, coalesce(l.tenant_id, n.tenant_id) tenant_id, l.n legacy_n, n.n nuevo_n
from (select w.tenant_id, count(*) n from public.sales_invoice_withholdings w
       where w.invoice_id in (select legacy_id from invoicing.documents where legacy_source = 'sales_invoices') group by 1) l
full join (select d.legacy_tenant_id tenant_id, count(*) n from invoicing.document_withholdings w
            join invoicing.documents d on d.id = w.document_id group by 1) n on l.tenant_id = n.tenant_id
where l.n is distinct from n.n
union all
select 'correos', coalesce(l.tenant_id, n.tenant_id), l.n, n.n
from (select e.tenant_id, count(*) n from public.sales_document_emails e group by 1) l
full join (select legacy_tenant_id tenant_id, count(*) n from invoicing.document_deliveries group by 1) n
  on l.tenant_id = n.tenant_id
where l.n is distinct from n.n;

\echo '== 5. Facturas en alcance legacy que NO tienen copia (deriva posterior a la migración o fallo)'
select si.id, si.tenant_id, si.status, si.invoice_prefix, si.invoice_number
from public.sales_invoices si
where (si.status not in ('pending', 'blocked_missing_buyer_data')
       or exists (select 1 from public.sales_credit_notes cn where cn.invoice_id = si.id)
       or exists (select 1 from public.sales_document_emails e where e.invoice_id = si.id))
  and not exists (select 1 from invoicing.documents d where d.legacy_source = 'sales_invoices' and d.legacy_id = si.id);

\echo '== 6. Copias cuyo estado difiere hoy del legacy (el legacy siguió avanzando)'
select d.legacy_id, d.status as nuevo, si.status as legacy
from invoicing.documents d join public.sales_invoices si on si.id = d.legacy_id
where d.legacy_source = 'sales_invoices' and d.status <> si.status;

\echo '== 7. Resumen del esquema nuevo'
select kind, status, count(*) n, count(*) filter (where xml_missing) sin_xml,
       count(*) filter (where issue_datetime_source = 'derived_utc_pre_fix') fecha_utc_pre_fix,
       count(*) filter (where issue_datetime_source = 'derived_unverified_window') hora_null_ventana,
       count(*) filter (where issue_datetime_source = 'derived_unverified_no_xml') hora_null_sin_xml
from invoicing.documents group by 1, 2 order by 1, 2;

\echo '== 8. Aceptadas/enviadas con fecha u hora declarada SIN verificar (issue_time_co null o fuente derived_*)'
select d.legacy_id, d.prefix, d.number, d.issued_at, d.issue_date_co, d.issue_time_co, d.issue_datetime_source, d.xml_path is not null as con_xml
from invoicing.documents d
where d.status in ('accepted', 'sent') and d.legacy_source is not null
  and (d.issue_time_co is null or d.issue_datetime_source like 'derived%')
order by d.issued_at;

\echo '== 9. Higiene de seguridad del esquema invoicing (todo debe estar vacío)'
\echo '   9a. tablas sin RLS'
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'invoicing' and c.relkind = 'r' and not c.relrowsecurity;
\echo '   9b. tablas con policies (se esperan 0)'
select schemaname, tablename, policyname from pg_policies where schemaname = 'invoicing';
\echo '   9c. privilegios de anon/authenticated/PUBLIC sobre tablas, o USAGE del esquema'
select c.relname, r.rolname
from pg_class c join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'invoicing'
cross join (select rolname from pg_roles where rolname in ('anon', 'authenticated')) r
where c.relkind = 'r' and has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete')
union all
select 'SCHEMA USAGE', r.rolname from pg_roles r
where r.rolname in ('anon', 'authenticated') and has_schema_privilege(r.rolname, 'invoicing', 'usage');
