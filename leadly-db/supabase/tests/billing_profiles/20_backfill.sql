set client_min_messages = warning;
create function t.bp(p_c text) returns public.client_billing_profiles language sql stable as
$$ select p from public.client_billing_profiles p where p.client_id = t.id(p_c) and p.deleted_at is null $$;
create function t.issues(p_c text) returns text[] language sql stable as
$$ select issues from public.client_billing_profile_review where client_id = t.id(p_c) $$;

do $$
declare p public.client_billing_profiles; n int; r record;
begin
  -- B1 quienes tienen perfil
  select count(*) into n from public.client_billing_profiles where tenant_id = t.id('A');
  perform t.ok('B1 tenant A: 12 perfiles (los elegibles)', n = 12, 'n=' || n);
  perform t.ok('B1b tenant B: 1 perfil', (select count(*) from public.client_billing_profiles where tenant_id = t.id('B')) = 1);
  perform t.ok('B2 sin perfil: cliente sin datos, eliminado y los Consumidor Final',
    not exists (select 1 from public.client_billing_profiles where client_id in (t.id('c_nodata'), t.id('c_deleted'), t.id('A_walkin'), t.id('B_walkin'))));
  perform t.ok('B3 cada cliente con perfil tiene exactamente un predeterminado',
    not exists (select 1 from public.client_billing_profiles group by tenant_id, client_id having count(*) filter (where is_default) <> 1));

  -- B4 completo: copia exacta
  p := t.bp('c_full');
  perform t.ok('B4 c_full: razon social, doc, correo del perfil (no del cliente)',
    p.legal_name = 'Acme SAS' and p.document_type_code = '31' and p.document_number = '900123456-7' and p.email = 'fact@acme.co');
  perform t.ok('B4b c_full: NIT -> organizacion juridica, regimen y esquema',
    p.organization_type = '1' and p.tax_level_code = 'O-13' and p.tax_scheme_code = '01' and p.delivery_method = 'email');
  perform t.ok('B4c c_full: domicilio en columnas con DIVIPOLA',
    p.address_line1 = 'Cra 1 #2-3' and p.country = 'CO' and p.state_code = '05' and p.city_code = '05001' and p.city = 'Medellín');
  perform t.ok('B4d c_full: sin problemas en la vista de revision', t.issues('c_full') = '{}');

  -- B5 sin correo
  p := t.bp('c_noemail');
  perform t.ok('B5 c_noemail: correo nulo (no inventado) y marcado en revision',
    p.email is null and p.legal_name = 'Sin Correo SA' and 'correo' = any (t.issues('c_noemail')));

  -- B6 DANE
  perform t.ok('B6 Belen ambiguo (sin departamento): NO se asigna codigo', (t.bp('c_belen')).city_code is null);
  perform t.ok('B6b Belen ambiguo aparece como DIVIPOLA sin resolver', 'municipio (DIVIPOLA) sin resolver' = any (t.issues('c_belen')));
  p := t.bp('c_belen_st');
  perform t.ok('B6c Belen + Boyaca: inequivoco -> 15087/15', p.city_code = '15087' and p.state_code = '15');
  p := t.bp('c_medellin');
  perform t.ok('B6d municipio unico por nombre -> 05001/05', p.city_code = '05001' and p.state_code = '05');
  p := t.bp('c_codes');
  perform t.ok('B6e codigos validos sin pais -> pais CO inferido', p.country = 'CO' and p.city_code = '11001' and p.state_code = '11');
  p := t.bp('c_badgeo');
  perform t.ok('B6f pareja DIVIPOLA incoherente se descarta (no viola el FK)', p.city_code is null and p.state_code is null and p.country = 'CO');

  -- B7 dos fiscales candidatas
  p := t.bp('c_two');
  perform t.ok('B7 c_two: sin domicilio elegido (ambiguo) y listado en revision',
    p.address_line1 is null and 'varias direcciones fiscales candidatas, sin domicilio elegido' = any (t.issues('c_two')));

  -- B8 solo retencion / extranjero
  p := t.bp('c_withh');
  perform t.ok('B8 solo retencion: perfil incompleto con applies_withholding', p.applies_withholding and p.document_number is null
    and 'número de documento' = any (t.issues('c_withh')));
  p := t.bp('c_foreign');
  perform t.ok('B8b extranjero: pais US sin geografia DIVIPOLA', p.country = 'US' and p.city_code is null and p.document_type_code = '22' and p.organization_type = '2');

  -- B9 clients intacto
  select count(*) into n from t.snap s
   where s.clients_md5 = (select md5(string_agg(c::text, '|' order by c.id)) from public.clients c) and s.clients_n = (select count(*) from public.clients);
  perform t.ok('B9 clients NO se modifico (md5 de todas las filas)', n = 1);
  perform t.ok('B9b contact_addresses: ninguna direccion movida ni borrada (updated_at intacto, 8 filas)',
    (select count(*) from public.contact_addresses) = 8
    and (select updated_at from public.contact_addresses where id = t.id('a_full_1')) = (select addr_updated from t.snap));

  -- B10 vista solo-facturacion
  select count(*) into n from public.contact_addresses_billing_only_review where tenant_id = t.id('A');
  perform t.ok('B10 vista solo-facturacion: 3 direcciones (c_two x2, c_noemail)', n = 3, 'n=' || n);
  perform t.ok('B10b esas direcciones siguen vivas y sin cambios', (select count(*) from public.contact_addresses where is_billing and not is_shipping and deleted_at is null) = 3);

  -- B11 incompletos
  select count(*) into n from public.client_billing_profile_review where tenant_id = t.id('A') and cardinality(issues) > 0;
  perform t.ok('B11 revision: perfiles con problemas = noemail, belen, two, withh (+c_badgeo)', n = 5, 'n=' || n);
end $$;

-- B12 idempotencia: re-ejecutar el backfill no crea ni cambia nada
create temp table before_bf as select md5(string_agg(p::text, '|' order by p.id)) as m, count(*) as n from public.client_billing_profiles p;
\set bf :MIGS/20261112121000_client_billing_profiles_backfill.sql
\i :bf
do $$
declare b record;
begin
  select * into b from before_bf;
  perform t.ok('B12 backfill idempotente: mismas filas y mismo contenido tras re-ejecutarlo',
    (select count(*) from public.client_billing_profiles) = b.n
    and (select md5(string_agg(p::text, '|' order by p.id)) from public.client_billing_profiles p) = b.m);
end $$;
