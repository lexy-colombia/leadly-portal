-- País / departamento / ciudad en el tenant, con catálogo real (2026-10-14).
--
-- Contexto: los datos fiscales de los clientes (tenants) no estaban listos
-- para facturar -- `country` era texto sin catálogo detrás, `state_province`
-- era texto libre ("Huila", "Bogotá D.C.") y no había ciudad. La DIAN valida
-- el código DIVIPOLA de municipio y departamento, no el nombre.
--
-- Decisiones del usuario (2026-10-14):
--   * El tenant gana país, departamento y ciudad.
--   * Departamento y ciudad SOLO aplican cuando el país es Colombia (CO).
--   * No se pide dígito de verificación (se calcula al emitir).
--   * Lo de dirección de facturación / clientes de los tenants queda para
--     después -- `tenants.billing_address` (texto) NO se toca acá.
--
-- Catálogo de países: ISO 3166-1 alpha-2 completo (249 códigos, validado
-- por conteo igual que DIVIPOLA). `is_enabled` marca los que la UI ofrece
-- hoy (los 11 que ya existían); el resto está cargado para no tener que
-- migrar cuando aparezca un cliente de otro país. Se eliminó el "OT"
-- ("Otro") porque no es un código ISO y no se puede mandar a la DIAN.

create table if not exists public.countries (
  code text primary key check (code ~ '^[A-Z]{2}$'),
  name text not null,
  is_enabled boolean not null default false
);

alter table public.countries enable row level security;
revoke all on public.countries from anon, authenticated;
grant select on public.countries to anon, authenticated;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'countries' and policyname = 'countries_select') then
    create policy countries_select on public.countries for select using (true);
  end if;
end $$;

insert into public.countries (code, name, is_enabled) values
  ('AD', 'Andorra', false),
  ('AE', 'Emiratos Árabes Unidos', false),
  ('AF', 'Afganistán', false),
  ('AG', 'Antigua y Barbuda', false),
  ('AI', 'Anguila', false),
  ('AL', 'Albania', false),
  ('AM', 'Armenia', false),
  ('AO', 'Angola', false),
  ('AQ', 'Antártida', false),
  ('AR', 'Argentina', true),
  ('AS', 'Samoa Americana', false),
  ('AT', 'Austria', false),
  ('AU', 'Australia', false),
  ('AW', 'Aruba', false),
  ('AX', 'Islas Aland', false),
  ('AZ', 'Azerbaiyán', false),
  ('BA', 'Bosnia y Herzegovina', false),
  ('BB', 'Barbados', false),
  ('BD', 'Bangladés', false),
  ('BE', 'Bélgica', false),
  ('BF', 'Burkina Faso', false),
  ('BG', 'Bulgaria', false),
  ('BH', 'Baréin', false),
  ('BI', 'Burundi', false),
  ('BJ', 'Benín', false),
  ('BL', 'San Bartolomé', false),
  ('BM', 'Bermudas', false),
  ('BN', 'Brunéi', false),
  ('BO', 'Bolivia', false),
  ('BQ', 'Caribe neerlandés', false),
  ('BR', 'Brasil', false),
  ('BS', 'Bahamas', false),
  ('BT', 'Bután', false),
  ('BV', 'Isla Bouvet', false),
  ('BW', 'Botsuana', false),
  ('BY', 'Bielorrusia', false),
  ('BZ', 'Belice', false),
  ('CA', 'Canadá', false),
  ('CC', 'Islas Cocos', false),
  ('CD', 'República Democrática del Congo', false),
  ('CF', 'República Centroafricana', false),
  ('CG', 'Congo', false),
  ('CH', 'Suiza', false),
  ('CI', 'Côte d’Ivoire', false),
  ('CK', 'Islas Cook', false),
  ('CL', 'Chile', true),
  ('CM', 'Camerún', false),
  ('CN', 'China', false),
  ('CO', 'Colombia', true),
  ('CR', 'Costa Rica', true),
  ('CU', 'Cuba', false),
  ('CV', 'Cabo Verde', false),
  ('CW', 'Curazao', false),
  ('CX', 'Isla de Navidad', false),
  ('CY', 'Chipre', false),
  ('CZ', 'Chequia', false),
  ('DE', 'Alemania', false),
  ('DJ', 'Yibuti', false),
  ('DK', 'Dinamarca', false),
  ('DM', 'Dominica', false),
  ('DO', 'República Dominicana', false),
  ('DZ', 'Argelia', false),
  ('EC', 'Ecuador', true),
  ('EE', 'Estonia', false),
  ('EG', 'Egipto', false),
  ('EH', 'Sáhara Occidental', false),
  ('ER', 'Eritrea', false),
  ('ES', 'España', true),
  ('ET', 'Etiopía', false),
  ('FI', 'Finlandia', false),
  ('FJ', 'Fiyi', false),
  ('FK', 'Islas Malvinas', false),
  ('FM', 'Micronesia', false),
  ('FO', 'Islas Feroe', false),
  ('FR', 'Francia', false),
  ('GA', 'Gabón', false),
  ('GB', 'Reino Unido', false),
  ('GD', 'Granada', false),
  ('GE', 'Georgia', false),
  ('GF', 'Guayana Francesa', false),
  ('GG', 'Guernesey', false),
  ('GH', 'Ghana', false),
  ('GI', 'Gibraltar', false),
  ('GL', 'Groenlandia', false),
  ('GM', 'Gambia', false),
  ('GN', 'Guinea', false),
  ('GP', 'Guadalupe', false),
  ('GQ', 'Guinea Ecuatorial', false),
  ('GR', 'Grecia', false),
  ('GS', 'Islas Georgia del Sur y Sandwich del Sur', false),
  ('GT', 'Guatemala', false),
  ('GU', 'Guam', false),
  ('GW', 'Guinea-Bisáu', false),
  ('GY', 'Guyana', false),
  ('HK', 'RAE de Hong Kong (China)', false),
  ('HM', 'Islas Heard y McDonald', false),
  ('HN', 'Honduras', false),
  ('HR', 'Croacia', false),
  ('HT', 'Haití', false),
  ('HU', 'Hungría', false),
  ('ID', 'Indonesia', false),
  ('IE', 'Irlanda', false),
  ('IL', 'Israel', false),
  ('IM', 'Isla de Man', false),
  ('IN', 'India', false),
  ('IO', 'Territorio Británico del Océano Índico', false),
  ('IQ', 'Irak', false),
  ('IR', 'Irán', false),
  ('IS', 'Islandia', false),
  ('IT', 'Italia', false),
  ('JE', 'Jersey', false),
  ('JM', 'Jamaica', false),
  ('JO', 'Jordania', false),
  ('JP', 'Japón', false),
  ('KE', 'Kenia', false),
  ('KG', 'Kirguistán', false),
  ('KH', 'Camboya', false),
  ('KI', 'Kiribati', false),
  ('KM', 'Comoras', false),
  ('KN', 'San Cristóbal y Nieves', false),
  ('KP', 'Corea del Norte', false),
  ('KR', 'Corea del Sur', false),
  ('KW', 'Kuwait', false),
  ('KY', 'Islas Caimán', false),
  ('KZ', 'Kazajistán', false),
  ('LA', 'Laos', false),
  ('LB', 'Líbano', false),
  ('LC', 'Santa Lucía', false),
  ('LI', 'Liechtenstein', false),
  ('LK', 'Sri Lanka', false),
  ('LR', 'Liberia', false),
  ('LS', 'Lesoto', false),
  ('LT', 'Lituania', false),
  ('LU', 'Luxemburgo', false),
  ('LV', 'Letonia', false),
  ('LY', 'Libia', false),
  ('MA', 'Marruecos', false),
  ('MC', 'Mónaco', false),
  ('MD', 'Moldavia', false),
  ('ME', 'Montenegro', false),
  ('MF', 'San Martín', false),
  ('MG', 'Madagascar', false),
  ('MH', 'Islas Marshall', false),
  ('MK', 'Macedonia del Norte', false),
  ('ML', 'Mali', false),
  ('MM', 'Myanmar (Birmania)', false),
  ('MN', 'Mongolia', false),
  ('MO', 'RAE de Macao (China)', false),
  ('MP', 'Islas Marianas del Norte', false),
  ('MQ', 'Martinica', false),
  ('MR', 'Mauritania', false),
  ('MS', 'Montserrat', false),
  ('MT', 'Malta', false),
  ('MU', 'Mauricio', false),
  ('MV', 'Maldivas', false),
  ('MW', 'Malaui', false),
  ('MX', 'México', true),
  ('MY', 'Malasia', false),
  ('MZ', 'Mozambique', false),
  ('NA', 'Namibia', false),
  ('NC', 'Nueva Caledonia', false),
  ('NE', 'Níger', false),
  ('NF', 'Isla Norfolk', false),
  ('NG', 'Nigeria', false),
  ('NI', 'Nicaragua', false),
  ('NL', 'Países Bajos', false),
  ('NO', 'Noruega', false),
  ('NP', 'Nepal', false),
  ('NR', 'Nauru', false),
  ('NU', 'Niue', false),
  ('NZ', 'Nueva Zelanda', false),
  ('OM', 'Omán', false),
  ('PA', 'Panamá', true),
  ('PE', 'Perú', true),
  ('PF', 'Polinesia Francesa', false),
  ('PG', 'Papúa Nueva Guinea', false),
  ('PH', 'Filipinas', false),
  ('PK', 'Pakistán', false),
  ('PL', 'Polonia', false),
  ('PM', 'San Pedro y Miquelón', false),
  ('PN', 'Islas Pitcairn', false),
  ('PR', 'Puerto Rico', false),
  ('PS', 'Territorios Palestinos', false),
  ('PT', 'Portugal', false),
  ('PW', 'Palaos', false),
  ('PY', 'Paraguay', false),
  ('QA', 'Catar', false),
  ('RE', 'Reunión', false),
  ('RO', 'Rumanía', false),
  ('RS', 'Serbia', false),
  ('RU', 'Rusia', false),
  ('RW', 'Ruanda', false),
  ('SA', 'Arabia Saudí', false),
  ('SB', 'Islas Salomón', false),
  ('SC', 'Seychelles', false),
  ('SD', 'Sudán', false),
  ('SE', 'Suecia', false),
  ('SG', 'Singapur', false),
  ('SH', 'Santa Elena', false),
  ('SI', 'Eslovenia', false),
  ('SJ', 'Svalbard y Jan Mayen', false),
  ('SK', 'Eslovaquia', false),
  ('SL', 'Sierra Leona', false),
  ('SM', 'San Marino', false),
  ('SN', 'Senegal', false),
  ('SO', 'Somalia', false),
  ('SR', 'Surinam', false),
  ('SS', 'Sudán del Sur', false),
  ('ST', 'Santo Tomé y Príncipe', false),
  ('SV', 'El Salvador', false),
  ('SX', 'Sint Maarten', false),
  ('SY', 'Siria', false),
  ('SZ', 'Esuatini', false),
  ('TC', 'Islas Turcas y Caicos', false),
  ('TD', 'Chad', false),
  ('TF', 'Territorios Australes Franceses', false),
  ('TG', 'Togo', false),
  ('TH', 'Tailandia', false),
  ('TJ', 'Tayikistán', false),
  ('TK', 'Tokelau', false),
  ('TL', 'Timor-Leste', false),
  ('TM', 'Turkmenistán', false),
  ('TN', 'Túnez', false),
  ('TO', 'Tonga', false),
  ('TR', 'Turquía', false),
  ('TT', 'Trinidad y Tobago', false),
  ('TV', 'Tuvalu', false),
  ('TW', 'Taiwán', false),
  ('TZ', 'Tanzania', false),
  ('UA', 'Ucrania', false),
  ('UG', 'Uganda', false),
  ('UM', 'Islas menores alejadas de EE. UU.', false),
  ('US', 'Estados Unidos', true),
  ('UY', 'Uruguay', false),
  ('UZ', 'Uzbekistán', false),
  ('VA', 'Ciudad del Vaticano', false),
  ('VC', 'San Vicente y las Granadinas', false),
  ('VE', 'Venezuela', true),
  ('VG', 'Islas Vírgenes Británicas', false),
  ('VI', 'Islas Vírgenes de EE. UU.', false),
  ('VN', 'Vietnam', false),
  ('VU', 'Vanuatu', false),
  ('WF', 'Wallis y Futuna', false),
  ('WS', 'Samoa', false),
  ('YE', 'Yemen', false),
  ('YT', 'Mayotte', false),
  ('ZA', 'Sudáfrica', false),
  ('ZM', 'Zambia', false),
  ('ZW', 'Zimbabue', false)
on conflict (code) do nothing;

-- Habilita la FK compuesta (departamento, ciudad) de tenants: la base misma
-- impide guardar una ciudad que no pertenece al departamento elegido.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cities_department_code_code_key') then
    alter table public.cities add constraint cities_department_code_code_key unique (department_code, code);
  end if;
end $$;

alter table public.tenants add column if not exists state_code text;
alter table public.tenants add column if not exists city_code text;
comment on column public.tenants.state_code is 'Código DANE del departamento (DIVIPOLA). Solo aplica si country = ''CO''.';
comment on column public.tenants.city_code is 'Código DANE del municipio (DIVIPOLA, 5 dígitos). Solo aplica si country = ''CO''. Su departamento debe coincidir con state_code (FK compuesta).';

-- Backfill (solo tenants de Colombia). Normaliza acentos/puntuación para
-- comparar "Bogotá D.C." contra "Bogotá, D.C.".
create function pg_temp.norm(t text) returns text language sql immutable as $f$
  select regexp_replace(translate(lower(coalesce(t, '')), 'áéíóúüñ', 'aeiouun'), '[^a-z0-9]', '', 'g')
$f$;

-- 1) departamento por el nombre ya guardado
update public.tenants t
   set state_code = d.code
  from public.departments d
 where t.country = 'CO' and t.state_code is null and t.state_province is not null
   and pg_temp.norm(d.name) = pg_temp.norm(t.state_province);

-- 2) ciudad + departamento desde el perfil DIAN cuando ya tiene código
--    (es el dato con el que ya se factura, así que manda).
update public.tenants t
   set state_code = c.department_code, city_code = c.code
  from public.tenant_dian_profile p
  join public.cities c on c.code = p.city_code
 where p.tenant_id = t.id and p.deleted_at is null
   and t.country = 'CO' and t.city_code is null;

-- 3) ciudad por el nombre del perfil DIAN, solo si hay exactamente una
--    coincidencia dentro del departamento (no se adivina).
update public.tenants t
   set city_code = m.city_code
  from (
    select t2.id, (array_agg(c.code))[1] as city_code, count(*) as n
      from public.tenants t2
      join public.tenant_dian_profile p on p.tenant_id = t2.id and p.deleted_at is null
      join public.cities c on c.department_code = t2.state_code
       and pg_temp.norm(c.name) like pg_temp.norm(p.city) || '%'
     where t2.country = 'CO' and t2.city_code is null and t2.state_code is not null
       and p.city is not null and pg_temp.norm(p.city) <> ''
     group by t2.id
  ) m
 where t.id = m.id and m.n = 1;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_country_fkey') then
    alter table public.tenants add constraint tenants_country_fkey
      foreign key (country) references public.countries(code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenants_state_code_fkey') then
    alter table public.tenants add constraint tenants_state_code_fkey
      foreign key (state_code) references public.departments(code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenants_state_city_fkey') then
    alter table public.tenants add constraint tenants_state_city_fkey
      foreign key (state_code, city_code) references public.cities(department_code, code);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenants_city_requires_state_check') then
    -- La FK compuesta no se evalúa si alguna columna es null (MATCH SIMPLE):
    -- sin esto se podría guardar una ciudad sin departamento.
    alter table public.tenants add constraint tenants_city_requires_state_check
      check (city_code is null or state_code is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'tenants_geo_only_colombia_check') then
    alter table public.tenants add constraint tenants_geo_only_colombia_check
      check (coalesce(country, '') = 'CO' or (state_code is null and city_code is null));
  end if;
end $$;

-- `state_province` (texto) se conserva porque lo leen el snapshot de
-- facturas, PDFs y listados; se mantiene sincronizado con el catálogo para
-- que nadie tenga que escribirlo a mano.
create or replace function public.sync_tenant_state_province()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.state_code is not null then
    select d.name into new.state_province from public.departments d where d.code = new.state_code;
  end if;
  return new;
end;
$$;
revoke all on function public.sync_tenant_state_province() from public, anon, authenticated;

drop trigger if exists tenants_sync_state_province on public.tenants;
create trigger tenants_sync_state_province
  before insert or update of state_code, state_province on public.tenants
  for each row execute function public.sync_tenant_state_province();

-- Quien factura a un tenant (payment_invoices) congela estos datos al
-- crear la factura; se agregan los códigos para no depender de texto.
alter table public.payment_invoices add column if not exists buyer_state_code text;
alter table public.payment_invoices add column if not exists buyer_city_code text;

create or replace function public.snapshot_invoice_buyer_and_tax()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant record;
begin
  if new.buyer_legal_name is null and new.payer_tenant_id is not null then
    select legal_name, name, document_type, document_number, contact_email, billing_address,
           country, state_province, state_code, city_code
      into v_tenant
    from public.tenants
    where id = new.payer_tenant_id;

    if found then
      new.buyer_legal_name := coalesce(v_tenant.legal_name, v_tenant.name);
      new.buyer_document_type := v_tenant.document_type;
      new.buyer_document_number := v_tenant.document_number;
      new.buyer_email := v_tenant.contact_email;
      new.buyer_address := v_tenant.billing_address;
      new.buyer_country := v_tenant.country;
      new.buyer_state_province := v_tenant.state_province;
      new.buyer_state_code := v_tenant.state_code;
      new.buyer_city_code := v_tenant.city_code;
    end if;
  end if;

  if new.subtotal_cents is null then
    new.subtotal_cents := round(new.amount_cents / (1 + new.tax_rate / 100))::integer;
    new.tax_cents := new.amount_cents - new.subtotal_cents;
  end if;

  return new;
end;
$$;
