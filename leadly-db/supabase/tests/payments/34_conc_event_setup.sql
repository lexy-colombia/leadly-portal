create table if not exists public.t_ev(r jsonb);
grant all on public.t_ev to service_role;
truncate public.t_ev;
select public.payments_begin_link((select id from payments.clients where name='Proyecto A'),'conc-ev','h',jsonb_build_object('amount_in_cents',5000000,'currency','COP','name','n','description','d','external_reference','CONC-EV'),'sandbox',null);
select public.payments_attach_wompi_link((select id from payments.payment_links where idempotency_key='conc-ev'),'wl_c','u');
