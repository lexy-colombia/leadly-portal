-- Estado "produccion" justo antes de la migracion de Barriles (ya aplicadas 150000 y 160000).
set client_min_messages = warning;
insert into public.tenants(id, name, legal_name, document_type, document_number, contact_email, country, status) values
 ('9c79437d-1c19-4edc-bc1f-0dc06094823a','Barriles de la sexta','INVERSIONES GASTRONOMICAS DEL HUILA SAS','NIT','902086977','barrilesdelasexta@gmail.com','CO','active'),
 ('dddddddd-0000-0000-0000-000000000001','Comercio real','Comercio real SAS','NIT','900111222','real@example.com','CO','active');
-- 21 modulos manuales de Barriles (faltan campaigns, automations, storefront)
insert into public.tenant_enabled_modules(tenant_id, module_key)
select '9c79437d-1c19-4edc-bc1f-0dc06094823a', k
from unnest(public.entitlement_module_keys()) k
where k not in ('campaigns','automations','storefront');
insert into public.tenant_enabled_modules(tenant_id, module_key) values
 ('cb195047-8cd2-4e38-9964-62bb99911814','sales'),
 ('dddddddd-0000-0000-0000-000000000001','products');
-- Otro comercio con suscripcion real y su factura (huella no trivial); periodo lejano.
insert into public.billing_subscriptions(id, tenant_id, plan_id, status, current_period_start, current_period_end)
select 'abababab-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001', p.id, 'ACTIVE',
       '2026-12-01 00:00:00-05', '2027-01-01 00:00:00-05'
from public.billing_plans p where p.key = 'starter';
-- Estres: aun si el plan enterprise tuviera implementacion, a Barriles no se le cobra.
update public.billing_plans set setup_fee_cents = 5000000 where key = 'enterprise';
set client_min_messages = notice;
