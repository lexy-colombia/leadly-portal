-- Elimina la integración "LaFactura.co" (proveedor 'lafactura') por pedido
-- explícito del usuario ("no quiero nada que ver con eso").
--
-- Contexto: la integración solo fue "mapeada" (20260811000013): guardaba una
-- cuenta pero ninguna Edge Function la llamó nunca. La facturación electrónica
-- real es 'dian_directo' (20260903104000), que NO se toca aquí.
--
-- Qué hace: borra las credenciales 'lafactura' de plataforma (tenant_id null)
-- y después la fila de integration_providers. integration_credentials.provider_key
-- es FK ON DELETE RESTRICT, por eso el orden importa.
--
-- Protección (aborta con RAISE EXCEPTION, sin borrar nada) si existe:
--   * una credencial 'lafactura' con tenant_id NO nulo (dato de un cliente),
--   * una credencial 'lafactura' con secretos en integration_credential_secrets
--     (no se destruyen secretos del Vault),
--   * cualquier otra tabla con FK hacia las credenciales/proveedor que tenga filas
--     apuntando a 'lafactura'.
-- Idempotente: si el proveedor ya no existe, solo avisa y termina.
--
-- NO revierte las migraciones 20260811000013/14/15: son historial y no se editan.
do $$
declare
  v_cnt integer;
  r record;
begin
  if not exists (select 1 from public.integration_providers where key = 'lafactura') then
    raise notice 'remove_lafactura_integration: el proveedor lafactura ya no existe, nada que hacer';
    return;
  end if;

  select count(*) into v_cnt
    from public.integration_credentials
    where provider_key = 'lafactura' and tenant_id is not null;
  if v_cnt > 0 then
    raise exception 'remove_lafactura_integration abortada: % credencial(es) lafactura pertenecen a un tenant (tenant_id no nulo); revisar y resolver a mano', v_cnt;
  end if;

  select count(*) into v_cnt
    from public.integration_credential_secrets s
    join public.integration_credentials c on c.id = s.credential_id
    where c.provider_key = 'lafactura';
  if v_cnt > 0 then
    raise exception 'remove_lafactura_integration abortada: % secreto(s) asociados a credenciales lafactura; no se destruyen secretos', v_cnt;
  end if;

  -- Otras tablas con FK hacia credenciales o proveedor (distintas de las dos conocidas).
  for r in
    select con.conrelid::regclass as tbl, a.attname as col, con.confrelid::regclass as ref
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.contype = 'f'
       and con.confrelid in ('public.integration_credentials'::regclass, 'public.integration_providers'::regclass)
       and con.conrelid not in ('public.integration_credential_secrets'::regclass, 'public.integration_credentials'::regclass)
  loop
    if r.ref = 'public.integration_credentials'::regclass then
      execute format(
        'select count(*) from %s t join public.integration_credentials c on c.id = t.%I where c.provider_key = ''lafactura''',
        r.tbl, r.col) into v_cnt;
    else
      execute format('select count(*) from %s t where t.%I = ''lafactura''', r.tbl, r.col) into v_cnt;
    end if;
    if v_cnt > 0 then
      raise exception 'remove_lafactura_integration abortada: % fila(s) en % referencian lafactura', v_cnt, r.tbl;
    end if;
  end loop;

  delete from public.integration_credentials where provider_key = 'lafactura' and tenant_id is null;
  delete from public.integration_providers where key = 'lafactura';
  raise notice 'remove_lafactura_integration: proveedor lafactura y sus credenciales de plataforma eliminados';
end
$$;
