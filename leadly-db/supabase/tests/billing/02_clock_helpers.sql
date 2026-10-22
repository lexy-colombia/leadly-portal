set client_min_messages = warning;
create function t.setclock(p timestamptz) returns void language sql as $$ update public.zz_clock set now = p $$;
create function t.sub_of(p_k text) returns uuid language sql stable as
  $$ select id from public.billing_subscriptions where tenant_id = t.id(p_k) order by created_at desc limit 1 $$;
create function t.ninv(p_sub uuid) returns bigint language sql stable as
  $$ select count(*) from public.payment_invoices where subscription_id = p_sub and deleted_at is null $$;
