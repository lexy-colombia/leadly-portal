-- S1 · PREFLIGHT (SOLO LECTURA) -- correr ANTES de aplicar las migraciones
-- 20261009180000/100/200. Solo lee public.*; no escribe nada, no requiere el
-- esquema invoicing. Re-ejecutable.
--   psql "$DB_URL" -f s1_preflight_legacy.sql
-- Cada sección imprime filas SOLO si hay algo que mirar, salvo "A" y "F" que
-- son resúmenes.

\echo '== A. Inventario legacy por tenant/estado y si entra en el alcance de la copia'
with scope as (
  select si.id from public.sales_invoices si
  where si.status not in ('pending', 'blocked_missing_buyer_data')
     or exists (select 1 from public.sales_credit_notes cn where cn.invoice_id = si.id)
     or exists (select 1 from public.sales_document_emails e where e.invoice_id = si.id)
)
select si.tenant_id, si.status, (si.id in (select id from scope)) as migra,
       count(*) n, count(si.cufe) con_cufe, count(si.xml_storage_path) con_xml,
       coalesce(sum(si.total), 0) sum_total
from public.sales_invoices si group by 1, 2, 3 order by 1, 2, 3;

\echo '== B. (order_id, attempt_number) duplicados en el alcance (debe estar vacío; si no, la migración aborta)'
select si.order_id, si.attempt_number, count(*)
from public.sales_invoices si
where si.status not in ('pending', 'blocked_missing_buyer_data')
   or exists (select 1 from public.sales_credit_notes cn where cn.invoice_id = si.id)
   or exists (select 1 from public.sales_document_emails e where e.invoice_id = si.id)
group by 1, 2 having count(*) > 1;

\echo '== C. NIT de los tenants relevantes: formato crudo, NIT separado, DV declarado vs módulo 11'
\echo '      invalido=true con documentos => la migración ABORTA; dv_mismatch=true => solo NOTICE'
\echo '      (el DV se separa por guion; nunca se concatena al número)'
with raw as (
  select t.id, t.name,
         btrim(coalesce(nullif(btrim(t.document_number::text), ''),
           (select s.seller_snapshot ->> 'document_number' from public.sales_invoices s
             where s.tenant_id = t.id and s.seller_snapshot ->> 'document_number' is not null
             order by s.created_at desc limit 1), '')) as nit_raw,
         (t.id in (select tenant_id from public.sales_invoices where status not in ('pending', 'blocked_missing_buyer_data')
                   union select tenant_id from public.sales_credit_notes
                   union select tenant_id from public.sales_invoices where id in (select invoice_id from public.sales_document_emails where invoice_id is not null))) as con_documentos,
         (t.id in (select tenant_id from public.tenant_dian_profile)) as con_perfil_dian
  from public.tenants t
), p as (
  select r.*, regexp_replace(r.nit_raw, '[.\s]', '', 'g') as clean from raw r
), q as (
  select p.*,
         case when clean ~ '^[0-9]+-[0-9]$' then split_part(clean, '-', 1)
              when clean ~ '^[0-9]+$' then clean else '' end as nit,
         case when clean ~ '^[0-9]+-[0-9]$' then split_part(clean, '-', 2)::int end as dv_declarado
  from p
)
select id, name, nit_raw, nit, dv_declarado,
       (nit !~ '^[0-9]{5,15}$') as invalido,
       (nit_raw ~ '[-.\s]') as trae_separadores,
       (dv_declarado is not null) as trae_dv
from q
where (con_documentos or con_perfil_dian)
  and (nit !~ '^[0-9]{5,15}$' or nit_raw ~ '[-.\s]');
\echo '      (el DV calculado se ve en el NOTICE de la migración / issuers.legacy_profile->_s1_nit)'

\echo '== C2. Facturas en alcance con estado que invoicing no admite (blocked con NC/correo): debe estar vacío'
select si.id, si.status from public.sales_invoices si
where si.status = 'blocked_missing_buyer_data'
  and (exists (select 1 from public.sales_credit_notes cn where cn.invoice_id = si.id)
       or exists (select 1 from public.sales_document_emails e where e.invoice_id = si.id));

\echo '== C3. ¿Ve este rol todas las filas? (RLS) -- rolbypassrls/superuser o dueño sin FORCE'
select current_user, r.rolsuper, r.rolbypassrls,
       (select count(*) from public.sales_invoices) as filas_visibles_sales_invoices
from pg_roles r where r.rolname = current_user;

\echo '== D. Aceptadas/enviadas sin CUFE (anómalo) o sin XML conservado (esperado: las anteriores a 2026-09-10)'
select si.id, si.tenant_id, si.invoice_prefix, si.invoice_number, si.status, si.issue_date,
       (si.cufe is null) as sin_cufe, (si.xml_storage_path is null) as sin_xml
from public.sales_invoices si
where si.status in ('accepted', 'sent') and (si.cufe is null or si.xml_storage_path is null)
order by si.issue_date;

\echo '== E. Fecha declarada ambigua: aceptadas/enviadas cuya fecha UTC != fecha Colombia'
\echo '      (previas al fix de hora 2026-09-10 14:52 -05 => se declaró la fecha UTC;'
\echo '       posteriores => fecha de Colombia; hasta 24 h después = ventana de despliegue incierta)'
select si.id, si.tenant_id, si.invoice_prefix, si.invoice_number, si.status, si.issue_date,
       (si.issue_date at time zone 'UTC')::date as fecha_utc,
       (si.issue_date at time zone 'America/Bogota')::date as fecha_colombia,
       case when si.issue_date < timestamptz '2026-09-10 14:52:16-05' then 'pre_fix: declarada=UTC'
            when si.issue_date < timestamptz '2026-09-10 14:52:16-05' + interval '24 hours' then 'ventana_despliegue: INCIERTO'
            else 'post_fix: declarada=Colombia' end as regla
from public.sales_invoices si
where si.status in ('accepted', 'sent') and si.issue_date is not null
  and (si.issue_date at time zone 'UTC')::date <> (si.issue_date at time zone 'America/Bogota')::date
order by si.issue_date;

\echo '== F. Correos y notas crédito: ¿apuntan a una factura fuera del alcance? (debe ser 0)'
select
  (select count(*) from public.sales_document_emails e
    where e.invoice_id is not null
      and not exists (select 1 from public.sales_invoices si where si.id = e.invoice_id)) as correos_huerfanos,
  (select count(*) from public.sales_credit_notes cn
    where not exists (select 1 from public.sales_invoices si where si.id = cn.invoice_id)) as nc_huerfanas,
  (select count(*) from public.sales_credit_notes) as notas_credito,
  (select count(*) from public.sales_document_emails) as correos_total;

\echo '== G. Estados inesperados de factura fuera del vocabulario del esquema nuevo (debe estar vacío)'
select status, count(*) from public.sales_invoices
where status not in ('pending','blocked_missing_buyer_data','generating','generated','sending','sent','accepted','rejected','error')
group by 1;
