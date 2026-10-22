-- Elimina el cliente de PRUEBA "Leadly" (kind='external', sandbox, creado el 2026-10-11)
-- de payments.clients junto con su unico link de prueba y su rastro. Pedido explicito
-- del usuario (2026-10-16): el link es sandbox y la API key nunca se uso. Se reemplaza por
-- el cliente interno "Leadly (interno)" (script create_internal_payments_client.ts).
--
-- payments.events / link_status_history son solo-insertar (triggers que prohiben delete):
-- se deshabilitan SOLO dentro de esta transaccion y se vuelven a habilitar antes de salir;
-- si cualquier comprobacion o sentencia falla, TODO se revierte (DDL transaccional).
--
-- Seguro y acotado: solo actua sobre ese cliente exacto y aborta si lo que encuentra no
-- coincide con lo verificado antes de escribir esta migracion (1 link, 0 entregas, 0
-- intentos, 3 filas de historial, 1 evento). En una base donde el cliente no existe
-- (local, otro ambiente) no hace nada.
do $$
declare
  v_client payments.clients%rowtype;
  v_link_ids uuid[];
  v_links int;
  v_deliveries int;
  v_attempts int;
  v_history int;
  v_events int;
  v_secret text;
begin
  select * into v_client
    from payments.clients
   where id = 'bbd10ad5-484a-4619-8ecc-33db41f1cd30'::uuid
     and name = 'Leadly'
     and kind = 'external';
  if not found then
    raise notice 'remove_sandbox_payments_client: el cliente de prueba no existe; no se hace nada.';
    return;
  end if;

  select coalesce(array_agg(id), '{}') into v_link_ids
    from payments.payment_links where client_id = v_client.id;
  v_links := coalesce(array_length(v_link_ids, 1), 0);

  select count(*) into v_deliveries from payments.deliveries where client_id = v_client.id;
  select count(*) into v_attempts
    from payments.delivery_attempts a join payments.deliveries d on d.id = a.delivery_id
   where d.client_id = v_client.id;
  select count(*) into v_history from payments.link_status_history where link_id = any (v_link_ids);
  select count(*) into v_events from payments.events where link_id = any (v_link_ids);

  -- Todos los links deben ser de sandbox (nunca se borra rastro de dinero real).
  if exists (select 1 from payments.payment_links where client_id = v_client.id and environment <> 'sandbox') then
    raise exception 'remove_sandbox_payments_client: hay links que no son sandbox; se aborta.';
  end if;
  if v_links <> 1 or v_deliveries <> 0 or v_attempts <> 0 or v_history <> 3 or v_events <> 1 then
    raise exception 'remove_sandbox_payments_client: conteos inesperados (links=%, entregas=%, intentos=%, historial=%, eventos=%); se aborta.',
      v_links, v_deliveries, v_attempts, v_history, v_events;
  end if;

  v_secret := v_client.signing_secret_name;

  alter table payments.events disable trigger events_append_only;
  alter table payments.link_status_history disable trigger link_status_history_append_only;

  -- Orden obligatorio: link_status_history.event_id referencia a events, asi que el
  -- historial se borra ANTES que los eventos.
  delete from payments.link_status_history where link_id = any (v_link_ids);
  delete from payments.events where link_id = any (v_link_ids);
  delete from payments.payment_links where id = any (v_link_ids);
  delete from payments.clients where id = v_client.id;

  alter table payments.events enable trigger events_append_only;
  alter table payments.link_status_history enable trigger link_status_history_append_only;

  -- Secreto de firma huerfano del cliente borrado (si el rol no puede, no se aborta el resto).
  if v_secret is not null and v_secret like 'payments/%' then
    begin
      delete from vault.secrets where name = v_secret;
    exception when others then
      raise notice 'remove_sandbox_payments_client: no se pudo borrar el secreto % del Vault (%); queda huerfano.', v_secret, sqlerrm;
    end;
  end if;

  raise notice 'remove_sandbox_payments_client: eliminados 1 cliente, 1 link, 3 historial, 1 evento.';
end
$$;
