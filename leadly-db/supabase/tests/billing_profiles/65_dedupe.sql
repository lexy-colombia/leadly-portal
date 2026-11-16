set client_min_messages = warning;
do $$
declare r text; n int; k text; cn text;
begin
  perform t.ok('D1 duplicado preexistente: uno conserva la clave, el otro queda NULL (no se borra nada)',
    (select address_dedupe_key is not null from public.contact_addresses where id = t.id('a_full_1'))
    and (select address_dedupe_key is null from public.contact_addresses where id = t.id('a_full_dup'))
    and (select count(*) from public.contact_addresses where contact_id = t.id('c_full')) = 2);
  perform t.ok('D1b la vista de revision lista el duplicado y apunta a la que se conserva',
    exists (select 1 from public.contact_addresses_duplicate_review where address_id = t.id('a_full_dup') and kept_address_id = t.id('a_full_1')));
  perform t.ok('D1c el predeterminado es el que se conserva', (select is_default from public.contact_addresses where id = t.id('a_full_1')));
  r := t.try(format($q$insert into public.contact_addresses(tenant_id, contact_id, line1, city, city_code, country) values (%L, %L, 'cra 1 #2 3', 'MEDELLIN', '05001', 'CO')$q$, t.id('A'), t.id('c_full')));
  perform t.ok('D2 insertar la misma direccion (otra capitalizacion, signos, pais CO) en el mismo cliente: 23505', r like '23505%', r);
  r := t.try(format($q$insert into public.contact_addresses(tenant_id, contact_id, line1, city, city_code, country) values (%L, %L, 'Cra 1 #2-3', 'Medellín', '05001', 'Colombia')$q$, t.id('A'), t.id('c_other')));
  perform t.ok('D3 la misma direccion en OTRO cliente: permitida', r = 'ok', r);
  r := t.try(format($q$insert into public.contact_addresses(tenant_id, contact_id, line1, city, city_code, country) values (%L, %L, 'Cra 1 #2-3 apto 4', 'Medellín', '05001', 'Colombia')$q$, t.id('A'), t.id('c_full')));
  perform t.ok('D4 direccion distinta (apto) en el mismo cliente: permitida', r = 'ok', r);
  update public.contact_addresses set deleted_at = now() where id = t.id('a_full_1');
  r := t.try(format($q$insert into public.contact_addresses(tenant_id, contact_id, line1, city, city_code, country) values (%L, %L, 'Cra 1 #2-3', 'Medellín', '05001', 'Colombia')$q$, t.id('A'), t.id('c_full')));
  perform t.ok('D5 tras eliminar la original, se puede volver a crear (el indice solo mira vivas)', r = 'ok', r);
  select address_dedupe_key into k from public.contact_addresses where id = t.id('a_ship');
  update public.contact_addresses set line1 = 'Otra calle 1' where id = t.id('a_ship');
  perform t.ok('D6 editar la linea recalcula la clave', (select address_dedupe_key from public.contact_addresses where id = t.id('a_ship')) is distinct from k);
  r := t.try(format($q$update public.contact_addresses set line1 = 'Calle Otro 7' where id = %L$q$, t.id('a_ship')));
  perform t.ok('D7 editar una direccion hasta igualar otra del mismo cliente: 23505 solo si es del mismo cliente (control: es de otro cliente -> ok)', r = 'ok', r);
  r := t.try(format($q$update public.contact_addresses set line1 = 'Cra 1 #2-3 apto 4' where id = %L$q$, t.id('a_full_dup')));
  perform t.ok('D8 editar un duplicado antiguo hasta chocar con una viva: 23505', r like '23505%', r);
  update public.contact_addresses set line1 = 'Cra 1 #2-3 apto 4' where false;
  -- D11: editar un duplicado PREEXISTENTE sin cambiar su direccion (como hace updateAddress: manda todos los campos)
  r := t.try(format($q$update public.contact_addresses set line1 = line1, line2 = line2, city = city, city_code = city_code, country = country, notes = 'editada', is_default = false where id = %L$q$, t.id('a_full_dup')));
  perform t.ok('D11 editar notas/predeterminada de un duplicado preexistente reenviando los mismos campos: NO falla y la clave sigue NULL',
    r = 'ok' and (select address_dedupe_key is null from public.contact_addresses where id = t.id('a_full_dup')), r);
  r := t.try(format($q$update public.contact_addresses set line1 = 'CRA 1 #2-3' where id = %L$q$, t.id('a_full_dup')));
  perform t.ok('D11b cambiar solo mayusculas/signos (misma clave normalizada) tampoco falla', r = 'ok', r);
  -- D12: nombre estable del constraint
  begin
    begin
      insert into public.contact_addresses(tenant_id, contact_id, line1, city, city_code, country) values (t.id('A'), t.id('c_full'), 'Cra 1 #2-3 apto 4', 'Medellín', '05001', 'Colombia');
    exception when unique_violation then get stacked diagnostics cn = constraint_name; end;
    perform t.ok('D12 el conflicto es reconocible: 23505 con constraint contact_addresses_unique_address_per_client', cn = 'contact_addresses_unique_address_per_client', cn);
  end;
  -- D13: direcciones sin linea 1 no chocan entre si
  insert into public.contact_addresses(tenant_id, contact_id, line1) values (t.id('A'), t.id('c_other'), ''), (t.id('A'), t.id('c_other'), '  ');
  perform t.ok('D13 dos direcciones vacias del mismo cliente no chocan (clave NULL)', true);
  perform t.ok('D9 ACL de las funciones del dedupe', not has_function_privilege('authenticated', 'public.contact_addresses_set_dedupe_key()', 'execute'));
  perform t.ok('D10 vista de duplicados sin acceso anon', t.try_as('anon', null, 'select 1 from public.contact_addresses_duplicate_review') like '42501%');
end $$;
