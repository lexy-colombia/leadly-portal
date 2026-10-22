set client_min_messages = warning;
insert into public.profiles(id, tenant_id, role) values ('00000000-0000-0000-0000-0000000000a1', null, 'superadmin');
insert into public.billing_plans(key, name, description, amount_cents, billing_interval) values
  ('zz_m', 'Zz mensual', 't', 10000000, 'monthly'),
  ('zz_y', 'Zz anual', 't', 100000000, 'yearly'),
  ('zz_free', 'Zz gratis', 't', 0, 'monthly');
insert into public.billing_plans(key, name, amount_cents, billing_interval, is_custom, setup_fee_cents)
  values ('zz_c', 'Zz a la medida', 0, 'monthly', true, 0);
