drop schema public cascade; create schema public;
create table tenants(id uuid primary key);
insert into tenants values ('11111111-1111-1111-1111-111111111111');
create table integration_providers(key text primary key, name text not null, category text not null, description text, is_active boolean not null default true);
create table integration_credentials(
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references tenants(id) on delete cascade,
  provider_key text not null references integration_providers(key) on delete restrict,
  mode text not null default 'sandbox', config jsonb not null default '{}', is_active boolean not null default true,
  deleted_at timestamptz);
create table integration_credential_secrets(
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references integration_credentials(id) on delete cascade,
  secret_name text not null, secret_id uuid not null, unique(credential_id, secret_name));
insert into integration_providers(key,name,category) values
 ('dian_directo','DIAN','invoicing'),('hubspot','HubSpot','other'),('lafactura','LaFactura','invoicing'),('shopify','Shopify','other'),('wompi','Wompi','other');
insert into integration_credentials(tenant_id,provider_key) values (null,'lafactura'),(null,'dian_directo'),('11111111-1111-1111-1111-111111111111','dian_directo');
