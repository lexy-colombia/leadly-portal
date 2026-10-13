-- Retiro del esquema `invoicing` (2026-10-10).
--
-- Por qué existe: el proyecto "facturación electrónica como servicio"
-- (progress/feature_invoicing_api.md) se PAUSÓ por decisión del usuario. Las
-- migraciones 20261009180100_invoicing_schema.sql y
-- 20261009180200_invoicing_backfill_from_legacy.sql crearon en producción el
-- esquema `invoicing` (14 tablas, 8 funciones, 11 triggers) y lo poblaron
-- copiando datos desde `public`. Esta migración lo quita.
--
-- Qué NO hace:
--   * NO revierte 180100/180200: siguen en el historial como huella de que se
--     aplicaron y luego se retiraron. Una base reconstruida desde cero las
--     corre y esta migración deja el resultado final consistente (sin esquema).
--   * NO toca `public` (sales_invoices, sales_credit_notes,
--     sales_document_emails, tenant_dian_profile, ...). La migración
--     20261009180000 (columnas test_set_id/webservice_url) se conserva: es
--     reconciliación de drift y no pertenece al esquema retirado.
--
-- Seguridad: DROP SCHEMA ... CASCADE borra en silencio cualquier objeto ajeno
-- que dependa del esquema (vistas, FKs, defaults). Por eso, antes, un bloque
-- DO verifica que NADA fuera de `invoicing` dependa de él y aborta con
-- RAISE EXCEPTION si encuentra algo -- en ese caso no se borra nada.
--
-- Idempotente: si el esquema ya no existe, es un no-op (el DROP corre solo si
-- el esquema existe y las verificaciones pasaron).

do $$
declare
  v_found text := '';
  v_n     bigint;
  v_list  text;
begin
  if not exists (select 1 from pg_namespace where nspname = 'invoicing') then
    raise notice 'drop_invoicing_schema: el esquema invoicing ya no existe, nada que hacer.';
    return;
  end if;

  -- Salvaguarda: la tabla legacy de facturas de public debe seguir ahí. Si no,
  -- el entorno no es el esperado y no se destruye nada.
  if to_regclass('public.sales_invoices') is null then
    raise exception 'drop_invoicing_schema: public.sales_invoices no existe; entorno inesperado, no se borra el esquema invoicing.';
  end if;

  -- (1) FKs entrantes: constraint FK definida en una tabla FUERA de invoicing
  --     que apunta a una tabla DENTRO de invoicing.
  select string_agg(format('%s.%s -> %s (%s)', cn.nspname, cl.relname, rn.nspname || '.' || rl.relname, c.conname), '; ')
    into v_list
    from pg_constraint c
    join pg_class cl     on cl.oid = c.conrelid
    join pg_namespace cn on cn.oid = cl.relnamespace
    join pg_class rl     on rl.oid = c.confrelid
    join pg_namespace rn on rn.oid = rl.relnamespace
   where c.contype = 'f' and rn.nspname = 'invoicing' and cn.nspname <> 'invoicing';
  if v_list is not null then
    v_found := v_found || E'\n  FK entrantes: ' || v_list;
  end if;

  -- (2) Vistas / vistas materializadas / reglas fuera de invoicing que
  --     dependan (pg_depend) de algún objeto de invoicing.
  select string_agg(distinct format('%s.%s', vn.nspname, vc.relname), '; ')
    into v_list
    from pg_depend d
    join pg_rewrite rw    on d.classid = 'pg_rewrite'::regclass and d.objid = rw.oid
    join pg_class vc      on vc.oid = rw.ev_class
    join pg_namespace vn  on vn.oid = vc.relnamespace
    join pg_class rc      on d.refclassid = 'pg_class'::regclass and rc.oid = d.refobjid
    join pg_namespace rn  on rn.oid = rc.relnamespace
   where rn.nspname = 'invoicing' and vn.nspname <> 'invoicing';
  if v_list is not null then
    v_found := v_found || E'\n  Vistas/reglas: ' || v_list;
  end if;

  -- (3) Funciones fuera de invoicing cuyo cuerpo mencione `invoicing.`
  --     (heurística textual: cubre llamadas y referencias a tablas).
  select string_agg(format('%s.%s', pn.nspname, p.proname), '; ')
    into v_list
    from pg_proc p
    join pg_namespace pn on pn.oid = p.pronamespace
   where pn.nspname <> 'invoicing'
     and pn.nspname not in ('pg_catalog', 'information_schema')
     and p.prokind in ('f', 'p')
     and p.prosrc ~* '\yinvoicing\s*\.';
  if v_list is not null then
    v_found := v_found || E'\n  Funciones que lo mencionan: ' || v_list;
  end if;

  -- (4) Triggers sobre tablas fuera de invoicing que ejecuten una función
  --     de invoicing.
  select string_agg(format('%s.%s (%s)', tn.nspname, tc.relname, t.tgname), '; ')
    into v_list
    from pg_trigger t
    join pg_class tc     on tc.oid = t.tgrelid
    join pg_namespace tn on tn.oid = tc.relnamespace
    join pg_proc p       on p.oid = t.tgfoid
    join pg_namespace pn on pn.oid = p.pronamespace
   where not t.tgisinternal and pn.nspname = 'invoicing' and tn.nspname <> 'invoicing';
  if v_list is not null then
    v_found := v_found || E'\n  Triggers: ' || v_list;
  end if;

  -- (5) Policies RLS fuera de invoicing que mencionen el esquema.
  select string_agg(format('%s.%s (%s)', pn.nspname, pc.relname, pol.polname), '; ')
    into v_list
    from pg_policy pol
    join pg_class pc     on pc.oid = pol.polrelid
    join pg_namespace pn on pn.oid = pc.relnamespace
   where pn.nspname <> 'invoicing'
     and (coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') ~* '\yinvoicing\s*\.'
       or coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') ~* '\yinvoicing\s*\.');
  if v_list is not null then
    v_found := v_found || E'\n  Policies: ' || v_list;
  end if;

  -- (6) Defaults de columna, y cualquier otra dependencia directa de tipo
  --     pg_depend desde columnas/defaults de tablas fuera de invoicing.
  select string_agg(distinct format('%s.%s', cn.nspname, cl.relname), '; ')
    into v_list
    from pg_depend d
    join pg_attrdef ad    on d.classid = 'pg_attrdef'::regclass and d.objid = ad.oid
    join pg_class cl      on cl.oid = ad.adrelid
    join pg_namespace cn  on cn.oid = cl.relnamespace
    join pg_namespace rn  on rn.oid = (
           select coalesce(
             (select relnamespace from pg_class where oid = d.refobjid and d.refclassid = 'pg_class'::regclass),
             (select pronamespace from pg_proc  where oid = d.refobjid and d.refclassid = 'pg_proc'::regclass),
             (select typnamespace from pg_type  where oid = d.refobjid and d.refclassid = 'pg_type'::regclass)))
   where rn.nspname = 'invoicing' and cn.nspname <> 'invoicing';
  if v_list is not null then
    v_found := v_found || E'\n  Defaults de columna: ' || v_list;
  end if;

  -- (7) Columnas fuera de invoicing cuyo TIPO sea un tipo de invoicing, y
  --     funciones fuera de invoicing que usen un tipo de invoicing.
  select count(*) into v_n
    from pg_attribute a
    join pg_class cl     on cl.oid = a.attrelid and cl.relkind in ('r','p','v','m','f')
    join pg_namespace cn on cn.oid = cl.relnamespace
    join pg_type ty      on ty.oid = a.atttypid
    join pg_namespace tn on tn.oid = ty.typnamespace
   where a.attnum > 0 and not a.attisdropped
     and tn.nspname = 'invoicing' and cn.nspname <> 'invoicing';
  if v_n > 0 then
    v_found := v_found || format(E'\n  Columnas con tipo de invoicing: %s', v_n);
  end if;

  -- (8) pg_cron (si existe) con jobs que mencionen el esquema.
  if to_regclass('cron.job') is not null then
    execute $q$select string_agg(coalesce(jobname, jobid::text), '; ')
                 from cron.job where command ~* '\yinvoicing\s*\.'$q$
       into v_list;
    if v_list is not null then
      v_found := v_found || E'\n  Jobs de cron: ' || v_list;
    end if;
  end if;

  if v_found <> '' then
    raise exception E'drop_invoicing_schema ABORTADA: hay objetos fuera del esquema invoicing que dependen de el. No se borro nada. Detalle:%', v_found;
  end if;

  -- El DROP vive DENTRO del mismo bloque, tras las verificaciones: aunque un
  -- cliente ejecute los statements sueltos y continue tras un error, jamas
  -- se llega al DROP si las verificaciones abortaron.
  drop schema invoicing cascade;
end
$$;
