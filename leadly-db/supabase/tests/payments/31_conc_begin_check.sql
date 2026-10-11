do $$
declare n_rows int; n_false int; n_total int; n_hist int;
begin
  select count(*) into n_rows from payments.payment_links where idempotency_key='conc-key-1';
  select count(*) into n_total from public.t_conc;
  select count(*) into n_false from public.t_conc where v='false';
  select count(*) into n_hist from payments.link_status_history h join payments.payment_links l on l.id=h.link_id where l.idempotency_key='conc-key-1';
  raise notice 'filas payment_links=% llamadas=% replayed=false:% historial=%', n_rows, n_total, n_false, n_hist;
  if n_rows <> 1 or n_total <> 20 or n_false <> 1 or n_hist <> 1 then raise exception 'FAIL: begin_link concurrente'; end if;
  raise notice 'PASS: 20 llamadas concurrentes con la misma clave -> 1 fila, 1 creada y 19 replays';
end $$;
