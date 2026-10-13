-- Esquema aislado `invoicing` (S1 de feature_invoicing_api, 2026-10-09).
--
-- Base de datos de un servicio de facturación electrónica DIAN consumible por
-- HTTP, independiente de sales_orders. Vive en este proyecto pero NO tiene
-- ninguna relación con `public`:
--   * ninguna FK, trigger, vista ni función de este esquema lee o escribe
--     tablas de `public`; las referencias al mundo Leadly son columnas planas
--     `legacy_*` (uuid, sin FK);
--   * las FK que existen son internas a `invoicing`;
--   * la ÚNICA lectura de `public` es la migración de copia
--     (20261009180200_invoicing_backfill_from_legacy.sql), que es un script
--     de una sola vez, no un objeto del esquema.
--
-- ACCESO (decisión, ver progress/S1_report.md §1.a):
--   El esquema NO se expone por PostgREST (`[api] schemas` queda en
--   public/graphql_public). Ni anon ni authenticated tienen USAGE sobre el
--   esquema ni privilegios sobre ningún objeto, y además toda tabla tiene RLS
--   activada SIN policies (cierre doble). Solo `service_role` tiene grants. La
--   Edge Function `invoicing-api` (S3) habla con este esquema por conexión
--   directa a Postgres (SUPABASE_DB_URL), con transacciones reales, no por
--   supabase-js/PostgREST.
--   Nada de esto crea policies a propósito: el aviso `rls_enabled_no_policy`
--   (INFO) de get_advisors es esperado y es la intención.
--
-- BORRADO: no hay soft-delete con deleted_at/deleted_by en documentos (igual
-- que sales_invoices: es un registro legal, "eliminar" no existe; un
-- documento pendiente sí puede borrarse, uno transmitido nunca). Cuentas,
-- emisores y claves se desactivan (status/revoked_at), no se borran.
--
-- Idempotente: create ... if not exists / create or replace / drop trigger if
-- exists. Re-ejecutarla no cambia nada.

create schema if not exists invoicing;

revoke all on schema invoicing from public;
revoke all on schema invoicing from anon, authenticated;
grant usage on schema invoicing to service_role;

-- ---------------------------------------------------------------------------
-- Funciones utilitarias propias (no se reusa public.set_updated_at a propósito:
-- este esquema no depende de ningún objeto de public).
-- ---------------------------------------------------------------------------
create or replace function invoicing.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Dígito de verificación del NIT (módulo 11, mismo algoritmo y pesos que
-- _shared/invoicing/nit.ts::computeNitCheckDigit; verificado contra los NIT
-- del ejemplo oficial: 800197268 -> 4, 900108281 -> 3).
create or replace function invoicing.nit_dv(p_nit text)
returns smallint
language plpgsql
immutable
set search_path = ''
as $$
declare
  d text := regexp_replace(coalesce(p_nit, ''), '\D', '', 'g');
  w int[] := array[3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  t int := 0;
  i int;
  r int;
begin
  if d = '' or length(d) > 15 then
    return null;
  end if;
  for i in 1..length(d) loop
    t := t + (substr(d, length(d) - i + 1, 1))::int * w[i];
  end loop;
  r := t % 11;
  return (case when r <= 1 then r else 11 - r end)::smallint;
end;
$$;

-- ---------------------------------------------------------------------------
-- accounts / issuers / api_keys
-- ---------------------------------------------------------------------------
create table if not exists invoicing.accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) > 0),
  status text not null default 'active' check (status in ('active', 'suspended')),
  contact_email text,
  -- Tenant de Leadly del que se migró esta cuenta (plano, SIN FK).
  legacy_tenant_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invoicing.issuers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references invoicing.accounts(id) on delete restrict,
  status text not null default 'active' check (status in ('active', 'disabled')),
  -- 'legacy': el motor actual de Leadly sigue siendo la autoridad de la
  -- numeración de este emisor; reserve_number() se NIEGA a entregar números.
  -- 'invoicing': este esquema es la autoridad. Se cambia a mano, en el corte
  -- por tenant (S4), DESPUÉS de resincronizar resolutions.next_number.
  engine text not null default 'legacy' check (engine in ('legacy', 'invoicing')),
  nit text not null check (nit ~ '^[0-9]{5,15}$'),
  dv smallint not null check (dv between 0 and 9),
  legal_name text not null check (length(btrim(legal_name)) > 0),
  -- Hoy hardcodeado "31" (NIT) en sendInvoiceToDian.ts:347.
  document_type_code text not null default '31',
  fiscal_regime text check (fiscal_regime in ('responsable_iva', 'no_responsable_iva')),
  is_self_withholding_agent boolean not null default false,
  address jsonb,
  city_name text,
  city_code text,
  state_name text,
  state_code text,
  country_code text not null default 'CO',
  contact_email text,
  contact_phone text,
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  software_id text,
  -- Modelo "software propio": el dueño del software es el propio emisor
  -- (sts:ProviderID = NIT del vendedor, buildInvoiceXml.ts:786). Si algún día
  -- hay Proveedor Tecnológico, este campo lleva el NIT de Lexy.
  software_provider_nit text,
  -- NIT de la DIAN como AuthorizationProvider (hoy hardcodeado en 4 sitios).
  authorization_provider_nit text not null default '800197268',
  test_set_id text,
  webservice_url text,
  -- Copia cruda de tenant_dian_profile al migrar (sin secretos): no pierde
  -- ninguna columna legacy aunque no tenga destino propio.
  legacy_profile jsonb,
  legacy_tenant_id uuid unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, account_id)
);
create unique index if not exists issuers_account_nit_env_idx
  on invoicing.issuers (account_id, nit, environment);

create table if not exists invoicing.api_keys (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references invoicing.accounts(id) on delete restrict,
  -- Si no es null, la clave solo opera sobre ese emisor (el emisor "se deriva
  -- de la clave", nunca del body). Si es null es una clave de cuenta.
  issuer_id uuid,
  name text not null,
  key_prefix text not null check (length(key_prefix) >= 6),
  -- sha256 hex del valor completo. El valor en claro NUNCA se guarda.
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default '{}',
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (issuer_id, account_id) references invoicing.issuers (id, account_id) on delete restrict
);
create index if not exists api_keys_account_idx on invoicing.api_keys (account_id);

-- ---------------------------------------------------------------------------
-- Secretos: SOLO referencias (nombres/rutas/ids), nunca valores.
-- ---------------------------------------------------------------------------
create table if not exists invoicing.issuer_secret_refs (
  id uuid primary key default gen_random_uuid(),
  issuer_id uuid not null references invoicing.issuers(id) on delete cascade,
  purpose text not null check (purpose in ('certificate_p12', 'certificate_password', 'software_pin', 'technical_key')),
  -- 'storage': objeto en un bucket privado. 'vault': secreto de Vault por
  -- nombre. 'legacy_integration_secret': secreto que sigue viviendo en
  -- integration_credential_secrets de Leadly (referenciado por id de la
  -- credencial + nombre; lo resuelve el servicio, no este esquema).
  source text not null check (source in ('storage', 'vault', 'legacy_integration_secret')),
  bucket text,
  object_path text,
  secret_name text,
  legacy_credential_id uuid,
  created_at timestamptz not null default now(),
  rotated_at timestamptz,
  unique (issuer_id, purpose),
  check (
    (source = 'storage' and bucket is not null and object_path is not null)
    or (source = 'vault' and secret_name is not null)
    or (source = 'legacy_integration_secret' and legacy_credential_id is not null and secret_name is not null)
  )
);

-- ---------------------------------------------------------------------------
-- Resoluciones y numeración
-- ---------------------------------------------------------------------------
create table if not exists invoicing.resolutions (
  id uuid primary key default gen_random_uuid(),
  issuer_id uuid not null references invoicing.issuers(id) on delete restrict,
  document_kind text not null check (document_kind in ('invoice', 'credit_note')),
  -- Número de la resolución DIAN. Una nota crédito no tiene resolución.
  resolution_number text,
  prefix text not null default '',
  range_from bigint not null check (range_from >= 0),
  -- Notas crédito: sin tope (la DIAN no exige rango para ellas).
  range_to bigint,
  valid_from date,
  valid_until date,
  technical_key_ref_id uuid references invoicing.issuer_secret_refs(id) on delete set null,
  -- Próximo número a entregar. Avanza en reserve_number(), de forma atómica.
  next_number bigint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (document_kind = 'credit_note' or range_to is not null),
  check (range_to is null or range_to >= range_from),
  check (next_number >= range_from)
);
create unique index if not exists resolutions_active_idx
  on invoicing.resolutions (issuer_id, document_kind, prefix) where is_active;

-- Números liberados por un intento rechazado/con error. Replica la regla
-- vigente ("un rechazo libera el número", applyDianVerdict.ts:15-22): el
-- siguiente reserve_number() reutiliza primero el hueco más bajo.
create table if not exists invoicing.number_gaps (
  resolution_id uuid not null references invoicing.resolutions(id) on delete cascade,
  number bigint not null,
  released_by_document_id uuid,
  released_at timestamptz not null default now(),
  consumed_at timestamptz,
  primary key (resolution_id, number)
);

-- ---------------------------------------------------------------------------
-- Documentos
-- ---------------------------------------------------------------------------
create table if not exists invoicing.documents (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null,
  issuer_id uuid not null,
  kind text not null check (kind in ('invoice', 'credit_note')),
  -- Idempotencia: la referencia del cliente (Idempotency-Key / id externo).
  external_reference text not null check (length(btrim(external_reference)) > 0),
  -- Un reintento tras rechazo es una fila NUEVA con attempt_number + 1.
  attempt_number integer not null default 1 check (attempt_number >= 1),
  -- Hash del cuerpo de la petición, para distinguir un replay legítimo de una
  -- reutilización de la misma referencia con otro contenido (409).
  request_hash text,
  status text not null default 'pending'
    check (status in ('pending', 'generating', 'generated', 'sending', 'sent', 'accepted', 'rejected', 'error')),
  status_detail text,
  environment text check (environment in ('sandbox', 'production')),
  -- true cuando `environment` se dedujo del ambiente VIGENTE del emisor al
  -- migrar (el esquema legacy no lo guardaba por documento).
  environment_is_derived boolean not null default false,
  resolution_id uuid references invoicing.resolutions(id) on delete set null,
  prefix text,
  number bigint,
  currency text not null default 'COP',
  -- Instante en que se generó/envió (legacy: issue_date timestamptz).
  issued_at timestamptz,
  -- Fecha y hora TAL COMO SE DECLARARON en el XML (cbc:IssueDate /
  -- cbc:IssueTime). Corrige de raíz el bug BF1: nadie vuelve a derivarlas
  -- con un slice UTC del timestamptz.
  issue_date_co date,
  issue_time_co text check (issue_time_co ~ '^[0-9]{2}:[0-9]{2}:[0-9]{2}-05:00$'),
  -- Cómo se obtuvieron las dos anteriores: 'declared' = persistidas por el
  -- motor nuevo al emitir; 'derived_*' = reconstruidas al migrar.
  -- 'declared': persistidas por el motor nuevo al emitir. 'derived_*':
  -- reconstruidas al migrar (nunca verificadas contra el XML);
  -- 'derived_unverified_*': ADEMÁS se desconoce la hora (issue_time_co null) y
  -- puede que la fecha (null si UTC y Colombia difieren). 'verified_xml' /
  -- 'corrected': un 'derived_*' contrastado o corregido después (el trigger
  -- solo permite ESA transición sobre documentos aceptados).
  issue_datetime_source text check (issue_datetime_source in (
    'declared', 'derived_colombia', 'derived_utc_pre_fix',
    'derived_unverified_no_xml', 'derived_unverified_window',
    'verified_xml', 'corrected'
  )),
  buyer jsonb not null default '{}'::jsonb,
  seller jsonb not null default '{}'::jsonb,
  subtotal numeric not null default 0,
  tax_total numeric not null default 0,
  withholding_total numeric not null default 0,
  total numeric not null default 0,
  -- Solo notas crédito.
  reason_code text check (reason_code in ('1', '2', '3', '4', '5', '6')),
  reason_description text,
  tax_type_code text,
  tax_rate numeric,
  referenced_document_id uuid references invoicing.documents(id) on delete restrict,
  -- Fecha de la factura referenciada TAL COMO la declaró esta nota crédito
  -- (cac:BillingReference/.../cbc:IssueDate). En filas migradas es la
  -- declarada por el motor legacy (slice UTC, bug BF1); en emisiones nuevas
  -- debe ser referenced_document.issue_date_co.
  referenced_issue_date_declared date,
  cufe text,
  cude text,
  xml_bucket text,
  xml_path text,
  -- true si el documento está transmitido/aceptado y NO hay XML conservado
  -- (irrecuperable: anterior a que se guardara el XML).
  xml_missing boolean not null default false,
  dian_tracking_id text,
  dian_response jsonb,
  sent_at timestamptz,
  accepted_at timestamptz,
  rejected_at timestamptz,
  created_by_api_key_id uuid references invoicing.api_keys(id) on delete set null,
  -- Trazabilidad hacia Leadly: planas, sin FK.
  legacy_source text check (legacy_source in ('sales_invoices', 'sales_credit_notes')),
  legacy_id uuid,
  legacy_tenant_id uuid,
  legacy_order_id uuid,
  legacy_created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (issuer_id, account_id) references invoicing.issuers (id, account_id) on delete restrict,
  unique (issuer_id, kind, external_reference, attempt_number),
  unique (legacy_source, legacy_id),
  check ((legacy_source is null) = (legacy_id is null)),
  check (kind = 'credit_note' or (cude is null and reason_code is null and referenced_document_id is null)),
  check (kind = 'invoice' or (cufe is null and reason_code is not null and referenced_document_id is not null))
);

-- Equivalente a sales_invoices_tenant_prefix_number_idx /
-- sales_credit_notes_tenant_prefix_number_idx (20260910040000): un número es
-- único por emisor+tipo+prefijo mientras el intento no esté rechazado/error.
create unique index if not exists documents_issuer_kind_prefix_number_idx
  on invoicing.documents (issuer_id, kind, prefix, number)
  where number is not null and status not in ('rejected', 'error');
create unique index if not exists documents_cufe_idx on invoicing.documents (cufe) where cufe is not null;
create unique index if not exists documents_cude_idx on invoicing.documents (cude) where cude is not null;
create index if not exists documents_issuer_created_idx on invoicing.documents (issuer_id, created_at desc);
create index if not exists documents_referenced_idx on invoicing.documents (referenced_document_id) where referenced_document_id is not null;
create index if not exists documents_status_idx on invoicing.documents (status) where status in ('pending', 'sending', 'sent');
create index if not exists documents_legacy_order_idx on invoicing.documents (legacy_order_id) where legacy_order_id is not null;

create index if not exists documents_resolution_idx on invoicing.documents (resolution_id) where resolution_id is not null;
create index if not exists documents_api_key_idx on invoicing.documents (created_by_api_key_id) where created_by_api_key_id is not null;
create index if not exists api_keys_issuer_idx on invoicing.api_keys (issuer_id) where issuer_id is not null;
create index if not exists resolutions_issuer_idx on invoicing.resolutions (issuer_id);
create index if not exists resolutions_technical_key_ref_idx on invoicing.resolutions (technical_key_ref_id) where technical_key_ref_id is not null;

create table if not exists invoicing.document_items (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references invoicing.documents(id) on delete cascade,
  display_order integer not null default 0,
  description text not null,
  sku text,
  quantity numeric not null default 1,
  unit_price numeric not null default 0,
  subtotal numeric not null default 0,
  tax_type_code text,
  tax_rate numeric not null default 0,
  tax_amount numeric not null default 0,
  taxable_base numeric not null default 0,
  legacy_id uuid unique,
  legacy_order_item_id uuid,
  created_at timestamptz not null default now()
);
create index if not exists document_items_document_idx on invoicing.document_items (document_id);

create table if not exists invoicing.document_withholdings (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references invoicing.documents(id) on delete cascade,
  tax_type_code text not null check (tax_type_code in ('05', '06', '07')),
  concept text,
  rate numeric not null default 0,
  base numeric not null default 0,
  amount numeric not null default 0,
  legacy_id uuid unique,
  created_at timestamptz not null default now()
);
create index if not exists document_withholdings_document_idx on invoicing.document_withholdings (document_id);

-- Bitácora de eventos del documento. Append-only.
create table if not exists invoicing.document_events (
  id bigint generated always as identity primary key,
  document_id uuid not null references invoicing.documents(id) on delete restrict,
  event_type text not null,
  from_status text,
  to_status text,
  detail jsonb,
  actor text,
  created_at timestamptz not null default now()
);
create index if not exists document_events_document_idx on invoicing.document_events (document_id, id);

-- Entregas al adquiriente (correo). Append-only: evidencia del numeral 9.3 del
-- Anexo Técnico; un reenvío es una fila nueva.
create table if not exists invoicing.document_deliveries (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references invoicing.documents(id) on delete restrict,
  channel text not null default 'email' check (channel in ('email')),
  recipient text not null,
  subject text not null,
  status text not null check (status in ('sent', 'error')),
  provider text not null default 'resend',
  provider_message_id text,
  error_detail text,
  attachments text[] not null default '{}',
  triggered_by text not null check (triggered_by in ('auto', 'manual')),
  legacy_id uuid unique,
  legacy_tenant_id uuid,
  legacy_created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists document_deliveries_document_idx on invoicing.document_deliveries (document_id);

-- ---------------------------------------------------------------------------
-- Webhooks
-- ---------------------------------------------------------------------------
create table if not exists invoicing.webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references invoicing.accounts(id) on delete restrict,
  issuer_id uuid,
  url text not null check (url ~ '^https://'),
  -- Referencia (nombre en Vault) al secreto de firma, nunca el valor.
  signing_secret_ref text not null,
  events text[] not null default array['document.accepted', 'document.rejected'],
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz,
  foreign key (issuer_id, account_id) references invoicing.issuers (id, account_id) on delete restrict
);

create table if not exists invoicing.webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  endpoint_id uuid not null references invoicing.webhook_endpoints(id) on delete cascade,
  document_id uuid references invoicing.documents(id) on delete set null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'delivered', 'failed')),
  attempts integer not null default 0,
  next_attempt_at timestamptz,
  last_http_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists webhook_deliveries_pending_idx
  on invoicing.webhook_deliveries (next_attempt_at) where status = 'pending';

-- ---------------------------------------------------------------------------
-- Triggers: updated_at
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['accounts', 'issuers', 'resolutions', 'documents', 'webhook_endpoints', 'webhook_deliveries'] loop
    execute format('drop trigger if exists %I on invoicing.%I', t || '_set_updated_at', t);
    execute format(
      'create trigger %I before update on invoicing.%I for each row execute function invoicing.set_updated_at()',
      t || '_set_updated_at', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Inmutabilidad
-- ---------------------------------------------------------------------------
-- documents:
--  * DELETE: solo un documento 'pending' (borrador) puede borrarse.
--  * UPDATE sobre un documento 'accepted': solo puede cambiar updated_at y la
--    ubicación del XML (xml_bucket/xml_path/xml_missing; p. ej. al copiar los
--    objetos a otro bucket). Nada fiscal más.
--  * UPDATE sobre sent/sending/rejected/error: los campos de identidad fiscal
--    no pueden cambiar una vez tienen valor (null -> valor sí se permite: es
--    como se completan cufe/number/issued_at al transmitir).
create or replace function invoicing.guard_document_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_locked text[] := array[
    'account_id', 'issuer_id', 'kind', 'external_reference', 'attempt_number',
    'resolution_id', 'prefix', 'number', 'currency',
    'issued_at', 'issue_date_co', 'issue_time_co', 'issue_datetime_source',
    'buyer', 'seller', 'subtotal', 'tax_total', 'withholding_total', 'total',
    'reason_code', 'reason_description', 'tax_type_code', 'tax_rate',
    'referenced_document_id', 'referenced_issue_date_declared',
    'cufe', 'cude', 'legacy_source', 'legacy_id'
  ];
  -- Campos de fecha que, siendo DERIVADOS (no declarados), se pueden
  -- corregir una sola vez: derived_* -> verified_xml | corrected.
  v_date_fields constant text[] := array[
    'issue_date_co', 'issue_time_co', 'issue_datetime_source', 'referenced_issue_date_declared'
  ];
  v_free text[] := array['updated_at', 'xml_bucket', 'xml_path', 'xml_missing'];
  v_corr boolean;
  k text;
  o jsonb;
  n jsonb;
begin
  if tg_op = 'DELETE' then
    if old.status <> 'pending' then
      raise exception 'Un documento en estado "%" no se puede borrar (registro fiscal inmutable).', old.status
        using errcode = 'IV423';
    end if;
    return old;
  end if;

  o := to_jsonb(old);
  n := to_jsonb(new);

  v_corr := coalesce(old.issue_datetime_source like 'derived%'
                     and new.issue_datetime_source in ('verified_xml', 'corrected'), false);
  if v_corr then
    v_free := v_free || v_date_fields;
    v_locked := array(select x from unnest(v_locked) x where x <> all (v_date_fields));
    insert into invoicing.document_events (document_id, event_type, from_status, to_status, detail, actor)
    values (old.id, 'issue_datetime_corrected', old.status, new.status,
            jsonb_build_object(
              'old', jsonb_build_object('issue_date_co', old.issue_date_co, 'issue_time_co', old.issue_time_co,
                                        'referenced_issue_date_declared', old.referenced_issue_date_declared,
                                        'source', old.issue_datetime_source),
              'new', jsonb_build_object('issue_date_co', new.issue_date_co, 'issue_time_co', new.issue_time_co,
                                        'referenced_issue_date_declared', new.referenced_issue_date_declared,
                                        'source', new.issue_datetime_source)),
            'trigger:guard_document_mutation');
  end if;

  if old.status = 'accepted' then
    if (o - v_free) is distinct from (n - v_free) then
      raise exception 'El documento % está aceptado por la DIAN: sus campos fiscales son inmutables.', old.id
        using errcode = 'IV423';
    end if;
    return new;
  end if;

  if old.status in ('sending', 'sent', 'rejected', 'error') then
    foreach k in array v_locked loop
      if o -> k <> 'null'::jsonb and (o -> k) is distinct from (n -> k) then
        raise exception 'El campo % del documento % no puede cambiar en estado "%".', k, old.id, old.status
          using errcode = 'IV423';
      end if;
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists documents_guard_mutation on invoicing.documents;
create trigger documents_guard_mutation
  before update or delete on invoicing.documents
  for each row execute function invoicing.guard_document_mutation();

-- Ítems y retenciones: solo se escriben mientras el documento está en un
-- estado previo a la transmisión.
create or replace function invoicing.guard_document_child_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_doc uuid;
  v_status text;
begin
  v_doc := case when tg_op = 'DELETE' then old.document_id else new.document_id end;
  select status into v_status from invoicing.documents where id = v_doc;
  -- Si el documento ya no existe (borrado en cascada de un borrador), permitir.
  if v_status is not null and v_status not in ('pending', 'generating', 'generated') then
    raise exception 'El documento % está en estado "%": sus ítems/retenciones son inmutables.', v_doc, v_status
      using errcode = 'IV423';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists document_items_guard_mutation on invoicing.document_items;
create trigger document_items_guard_mutation
  before insert or update or delete on invoicing.document_items
  for each row execute function invoicing.guard_document_child_mutation();

drop trigger if exists document_withholdings_guard_mutation on invoicing.document_withholdings;
create trigger document_withholdings_guard_mutation
  before insert or update or delete on invoicing.document_withholdings
  for each row execute function invoicing.guard_document_child_mutation();

-- Tablas append-only.
create or replace function invoicing.forbid_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'La tabla invoicing.% es append-only.', tg_table_name using errcode = 'IV423';
end;
$$;

do $$
declare t text;
begin
  foreach t in array array['document_events', 'document_deliveries'] loop
    execute format('drop trigger if exists %I on invoicing.%I', t || '_append_only', t);
    execute format(
      'create trigger %I before update or delete on invoicing.%I for each row execute function invoicing.forbid_mutation()',
      t || '_append_only', t
    );
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- Numeración atómica
-- ---------------------------------------------------------------------------
-- reserve_number: entrega UN número del rango activo del emisor. Atómica: la
-- fila de la resolución se bloquea (FOR UPDATE) hasta el commit del caller, así
-- que dos reservas concurrentes se serializan y nunca reciben el mismo número.
--
-- ⚠️ La reserva vive en la transacción del caller. Si el caller hace rollback,
-- el número vuelve (no se consume). Para persistirla junto al documento en una
-- sola transacción usar assign_document_number().
--
-- SQLSTATE propios: IV404 emisor inexistente/inactivo, IV409 el emisor aún
-- está bajo el motor 'legacy', IV410 sin resolución activa vigente,
-- IV411 rango agotado, IV412 prefijo ambiguo.
create or replace function invoicing.reserve_number(
  p_issuer_id uuid,
  p_kind text,
  p_prefix text default null
)
returns table (resolution_id uuid, prefix text, number bigint)
language plpgsql
set search_path = ''
as $$
declare
  v_engine text;
  v_today date := (now() at time zone 'America/Bogota')::date;
  v_candidates integer;
  r invoicing.resolutions%rowtype;
  v_gap bigint;
begin
  select i.engine into v_engine
  from invoicing.issuers i
  where i.id = p_issuer_id and i.status = 'active';
  if not found then
    raise exception 'Emisor % no encontrado o inactivo.', p_issuer_id using errcode = 'IV404';
  end if;
  if v_engine <> 'invoicing' then
    raise exception 'El emisor % sigue bajo el motor legacy: la numeración no se entrega desde invoicing.', p_issuer_id
      using errcode = 'IV409';
  end if;
  if p_kind not in ('invoice', 'credit_note') then
    raise exception 'Tipo de documento inválido: %.', p_kind using errcode = 'IV404';
  end if;

  select count(*) into v_candidates
  from invoicing.resolutions x
  where x.issuer_id = p_issuer_id and x.document_kind = p_kind and x.is_active
    and (p_prefix is null or x.prefix = p_prefix)
    and (x.valid_from is null or x.valid_from <= v_today)
    and (x.valid_until is null or x.valid_until >= v_today);
  if v_candidates = 0 then
    raise exception 'El emisor % no tiene una resolución activa y vigente para %.', p_issuer_id, p_kind
      using errcode = 'IV410';
  end if;
  if v_candidates > 1 then
    raise exception 'El emisor % tiene más de una resolución activa para %: indique el prefijo.', p_issuer_id, p_kind
      using errcode = 'IV412';
  end if;

  select x.* into r
  from invoicing.resolutions x
  where x.issuer_id = p_issuer_id and x.document_kind = p_kind and x.is_active
    and (p_prefix is null or x.prefix = p_prefix)
    and (x.valid_from is null or x.valid_from <= v_today)
    and (x.valid_until is null or x.valid_until >= v_today)
  for update;

  -- Primero los huecos liberados por rechazos (el más bajo).
  select g.number into v_gap
  from invoicing.number_gaps g
  where g.resolution_id = r.id and g.consumed_at is null
  order by g.number
  limit 1
  for update;

  if found then
    update invoicing.number_gaps g set consumed_at = now()
    where g.resolution_id = r.id and g.number = v_gap;
    return query select r.id, r.prefix, v_gap;
    return;
  end if;

  if r.range_to is not null and r.next_number > r.range_to then
    raise exception 'El rango de la resolución % está agotado (último número: %).', r.id, r.range_to
      using errcode = 'IV411';
  end if;

  update invoicing.resolutions x set next_number = x.next_number + 1 where x.id = r.id;
  return query select r.id, r.prefix, r.next_number;
end;
$$;

-- assign_document_number: reserva y asigna el número al documento en UNA
-- transacción (no puede quedar un número reservado sin documento, ni un
-- documento sin número, por un crash entre dos llamadas).
create or replace function invoicing.assign_document_number(p_document_id uuid)
returns table (resolution_id uuid, prefix text, number bigint)
language plpgsql
set search_path = ''
as $$
declare
  d invoicing.documents%rowtype;
  v_res uuid;
  v_prefix text;
  v_number bigint;
begin
  select * into d from invoicing.documents x where x.id = p_document_id for update;
  if not found then
    raise exception 'Documento % no encontrado.', p_document_id using errcode = 'IV404';
  end if;
  if d.status <> 'pending' or d.number is not null then
    raise exception 'El documento % ya tiene número o no está pendiente.', p_document_id using errcode = 'IV409';
  end if;

  select r.resolution_id, r.prefix, r.number into v_res, v_prefix, v_number
  from invoicing.reserve_number(d.issuer_id, d.kind) r;

  update invoicing.documents x
  set resolution_id = v_res, prefix = v_prefix, number = v_number
  where x.id = p_document_id;

  return query select v_res, v_prefix, v_number;
end;
$$;

-- release_number: un documento rechazado/con error libera su número para el
-- próximo intento (replica applyDianVerdict.ts). No hace nada si otro
-- documento vivo ya ocupa ese número. El documento conserva el número para
-- auditoría (el índice único parcial excluye rejected/error).
create or replace function invoicing.release_number(p_document_id uuid)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  d invoicing.documents%rowtype;
  v_rows integer;
begin
  select * into d from invoicing.documents x where x.id = p_document_id for update;
  if not found or d.status not in ('rejected', 'error') or d.number is null or d.resolution_id is null then
    return false;
  end if;

  perform 1 from invoicing.resolutions r where r.id = d.resolution_id for update;

  if exists (
    select 1 from invoicing.documents o
    where o.issuer_id = d.issuer_id and o.kind = d.kind
      and o.prefix is not distinct from d.prefix and o.number = d.number
      and o.status not in ('rejected', 'error') and o.id <> d.id
  ) then
    return false;
  end if;

  -- Un mismo documento no puede reabrir dos veces el mismo hueco (si ese
  -- número ya lo reutilizó otro documento, solo ESE otro puede liberarlo).
  insert into invoicing.number_gaps as g (resolution_id, number, released_by_document_id)
  values (d.resolution_id, d.number, d.id)
  on conflict (resolution_id, number) do update
    set consumed_at = null, released_by_document_id = excluded.released_by_document_id, released_at = now()
    where g.consumed_at is not null
      and g.released_by_document_id is distinct from excluded.released_by_document_id;
  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS cerrada + grants mínimos
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'invoicing' loop
    execute format('alter table invoicing.%I enable row level security', t);
  end loop;
end;
$$;

revoke all on all tables in schema invoicing from public, anon, authenticated;
revoke all on all sequences in schema invoicing from public, anon, authenticated;
revoke all on all functions in schema invoicing from public, anon, authenticated;

grant select, insert, update, delete on
  invoicing.accounts, invoicing.issuers, invoicing.api_keys, invoicing.issuer_secret_refs,
  invoicing.resolutions, invoicing.number_gaps, invoicing.documents, invoicing.document_items,
  invoicing.document_withholdings, invoicing.webhook_endpoints, invoicing.webhook_deliveries
  to service_role;
-- Append-only: sin update/delete ni a service_role (además del trigger).
grant select, insert on invoicing.document_events, invoicing.document_deliveries to service_role;
grant usage, select on all sequences in schema invoicing to service_role;
grant execute on all functions in schema invoicing to service_role;

create index if not exists webhook_endpoints_account_idx on invoicing.webhook_endpoints (account_id);
create index if not exists webhook_endpoints_issuer_idx on invoicing.webhook_endpoints (issuer_id) where issuer_id is not null;
create index if not exists webhook_deliveries_endpoint_idx on invoicing.webhook_deliveries (endpoint_id);
create index if not exists webhook_deliveries_document_idx on invoicing.webhook_deliveries (document_id) where document_id is not null;
