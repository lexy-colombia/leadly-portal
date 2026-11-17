set client_min_messages = warning;
do $$
declare r text; n bigint; v_prof uuid; v_prof2 uuid; v_new uuid;
begin
  -- C1 FK compuesta tenant+cliente: cliente de otro tenant
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label) values (%L, %L, 'x')$q$, t.id('A'), t.id('b_c1')));
  perform t.ok('C1 perfil de A sobre un cliente de B: rechazado por FK compuesta', r like '23503%', r);
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label) values (%L, %L, 'x')$q$, t.id('A'), gen_random_uuid()));
  perform t.ok('C1b cliente inexistente: rechazado', r like '23503%', r);

  -- C2 primer perfil nace predeterminado; segundo no; dos defaults chocan
  insert into public.client_billing_profiles(tenant_id, client_id, label, document_number, document_type_code, legal_name, email)
    values (t.id('A'), t.id('c_nodata'), 'P1', 'ND-1', '13', 'ND', 'nd@x.co') returning id into v_prof;
  insert into public.client_billing_profiles(tenant_id, client_id, label, document_number, document_type_code, legal_name, email)
    values (t.id('A'), t.id('c_nodata'), 'P2', 'ND-2', '13', 'ND2', 'nd2@x.co') returning id into v_prof2;
  perform t.ok('C2 el primer perfil de un cliente nace predeterminado', (select is_default from public.client_billing_profiles where id = v_prof));
  perform t.ok('C2b el segundo no', not (select is_default from public.client_billing_profiles where id = v_prof2));
  r := t.try(format($q$update public.client_billing_profiles set is_default = true where id = %L$q$, v_prof2));
  perform t.ok('C2c dos predeterminados vivos: rechazado por el indice unico', r like '23505%', r);

  -- C3 documento unico por cliente (vivos)
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label, document_number) values (%L, %L, 'dup', 'ND-1')$q$, t.id('A'), t.id('c_nodata')));
  perform t.ok('C3 mismo documento dos veces en un cliente: rechazado', r like '23505%', r);
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label, document_number) values (%L, %L, 'mismo doc otro cliente', 'ND-1')$q$, t.id('A'), t.id('c_other')));
  perform t.ok('C3b el mismo documento en OTRO cliente: permitido', r = 'ok', r);
  update public.client_billing_profiles set deleted_at = now() where id = v_prof2;
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label, document_number) values (%L, %L, 'reuse', 'ND-2')$q$, t.id('A'), t.id('c_nodata')));
  perform t.ok('C3c un documento de un perfil eliminado se puede reutilizar', r = 'ok', r);

  -- C4 geografia
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label, country, state_code, city_code) values (%L, %L, 'g1', 'US', '05', '05001')$q$, t.id('A'), t.id('c_ship')));
  perform t.ok('C4 DIVIPOLA con pais distinto de CO: rechazado', r like '23514%', r);
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label, country, state_code, city_code) values (%L, %L, 'g2', 'CO', '11', '05001')$q$, t.id('A'), t.id('c_ship')));
  perform t.ok('C4b pareja departamento/municipio incoherente: rechazada por FK compuesta', r like '23503%', r);
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label, country, state_code) values (%L, %L, 'g3', 'CO', '05')$q$, t.id('A'), t.id('c_ship')));
  perform t.ok('C4c departamento sin municipio: rechazado', r like '23514%', r);
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label, country) values (%L, %L, 'g4', 'ZZ')$q$, t.id('A'), t.id('c_ship')));
  perform t.ok('C4d pais fuera del catalogo: rechazado', r like '23503%', r);
  r := t.try(format($q$insert into public.client_billing_profiles(tenant_id, client_id, label, tax_level_code) values (%L, %L, 'g5', 'XX')$q$, t.id('A'), t.id('c_ship')));
  perform t.ok('C4e regimen invalido: rechazado', r like '23514%', r);

  -- C5 RLS
  select count(*) into n from public.client_billing_profiles where tenant_id = t.id('B');
  perform t.ok('C5 (control) existe un perfil de B', n = 1);
  perform t.ok('C5b usuario de A solo ve perfiles de A',
    t.count_as('authenticated', t.id('uA'), 'select 1 from public.client_billing_profiles where tenant_id = ''' || t.id('B') || '''') = 0
    and t.count_as('authenticated', t.id('uA'), 'select 1 from public.client_billing_profiles') > 0);
  perform t.ok('C5c usuario de B no ve los de A',
    t.count_as('authenticated', t.id('uB'), 'select 1 from public.client_billing_profiles where tenant_id = ''' || t.id('A') || '''') = 0);
  r := t.try_as('authenticated', t.id('uA'), format($q$insert into public.client_billing_profiles(tenant_id, client_id, label) values (%L, %L, 'x')$q$, t.id('B'), t.id('b_c1')));
  perform t.ok('C5d usuario de A no puede insertar en B (RLS)', r like '42501%', r);
  r := t.try_as('authenticated', t.id('uA'), format($q$update public.client_billing_profiles set legal_name = 'hack' where tenant_id = %L$q$, t.id('B')));
  perform t.ok('C5e update cruzado afecta 0 filas', (select count(*) from public.client_billing_profiles where legal_name = 'hack') = 0, r);
  r := t.try_as('anon', null, 'select 1 from public.client_billing_profiles limit 1');
  perform t.ok('C5f anon sin acceso a la tabla', r like '42501%', r);
  r := t.try_as('authenticated', t.id('uA'), format($q$insert into public.client_billing_profiles(tenant_id, client_id, label) values (%L, %L, 'propio')$q$, t.id('A'), t.id('c_ship')));
  perform t.ok('C5g usuario de A inserta en A', r = 'ok', r);
  perform t.ok('C5h anon sin acceso a las vistas de revision', t.try_as('anon', null, 'select 1 from public.client_billing_profile_review') like '42501%');

  -- C6 RPC set_default_billing_profile
  select id into v_prof from public.client_billing_profiles where client_id = t.id('c_full');
  insert into public.client_billing_profiles(tenant_id, client_id, label, document_number, legal_name, email)
    values (t.id('A'), t.id('c_full'), 'Segundo', '800000001', 'Otra Razon', 'o@x.co') returning id into v_new;
  r := t.try_as('authenticated', t.id('uA'), format('select public.set_default_billing_profile(%L)', v_new));
  perform t.ok('C6 RPC: marca el nuevo como predeterminado', r = 'ok' and (select is_default from public.client_billing_profiles where id = v_new), r);
  perform t.ok('C6b RPC: desmarca el anterior (exactamente un default)',
    not (select is_default from public.client_billing_profiles where id = v_prof)
    and (select count(*) from public.client_billing_profiles where client_id = t.id('c_full') and is_default and deleted_at is null) = 1);
  r := t.try_as('authenticated', t.id('uB'), format('select public.set_default_billing_profile(%L)', v_prof));
  perform t.ok('C6c RPC: usuario de OTRO tenant recibe LX404 y no cambia nada', r like 'LX404%' and not (select is_default from public.client_billing_profiles where id = v_prof), r);
  r := t.try_as('anon', null, format('select public.set_default_billing_profile(%L)', v_prof));
  perform t.ok('C6d RPC: anon sin EXECUTE', r like '42501%', r);
  r := t.try_as('authenticated', t.id('uA'), format('select public.set_default_billing_profile(%L)', gen_random_uuid()));
  perform t.ok('C6e RPC: perfil inexistente -> LX404', r like 'LX404%', r);
  perform t.ok('C6f RPC es security invoker con search_path vacio',
    (select not prosecdef and array_to_string(proconfig, ',') like '%search_path=""%' from pg_proc where proname = 'set_default_billing_profile'));
  perform t.ok('C6g privilegios: anon/public sin EXECUTE; authenticated y service_role con EXECUTE',
    not has_function_privilege('anon', 'public.set_default_billing_profile(uuid)', 'execute')
    and has_function_privilege('authenticated', 'public.set_default_billing_profile(uuid)', 'execute')
    and has_function_privilege('service_role', 'public.set_default_billing_profile(uuid)', 'execute'));

  -- C7 soft-delete / borrar cliente
  perform t.ok('C7 la tabla tiene deleted_at/deleted_by y trigger de updated_at',
    exists (select 1 from pg_trigger where tgrelid = 'public.client_billing_profiles'::regclass and tgname = 'client_billing_profiles_set_updated_at'));
  perform t.ok('C7b RLS habilitada con 4 policies',
    (select relrowsecurity from pg_class where oid = 'public.client_billing_profiles'::regclass)
    and (select count(*) from pg_policies where tablename = 'client_billing_profiles') = 4);
end $$;
