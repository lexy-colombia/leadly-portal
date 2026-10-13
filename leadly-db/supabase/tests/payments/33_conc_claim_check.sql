do $$
declare n int; nd int;
begin
  select count(*), count(distinct delivery_id) into n, nd from public.t_claim;
  raise notice 'reclamos=% distintos=%', n, nd;
  if n <> 50 or nd <> 50 then raise exception 'FAIL: doble entrega o entregas perdidas en claim concurrente'; end if;
  raise notice 'PASS: 10 workers concurrentes reclamaron 50 entregas sin duplicados (SKIP LOCKED)';
end $$;
