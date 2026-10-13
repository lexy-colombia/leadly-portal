create table if not exists public.t_claim(delivery_id uuid);
grant all on public.t_claim to service_role;
truncate public.t_claim;
update payments.deliveries set status='delivered' where status='pending';
select public.payments_record_event(t.ev('wl_1','CLAIM'||g,'PENDING'),'test',true) from generate_series(1,50) g;
do $$ begin
  if (select count(*) from payments.deliveries where status='pending')<>50 then raise exception 'setup claim: esperaba 50 pendientes'; end if;
end $$;
