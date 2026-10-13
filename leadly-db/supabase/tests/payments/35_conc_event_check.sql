do $$
declare v_proc int; v_dup_pay int; v_dup int; v_tx int; v_paid int; v_total int; v_status text; v_errs int;
begin
  select count(*) into v_total from public.t_ev;
  select count(*) filter (where classification='processed'), count(*) filter (where classification='duplicate_payment'),
         count(*) filter (where classification='duplicate'), count(distinct transaction_id)
    into v_proc, v_dup_pay, v_dup, v_tx
    from payments.events where wompi_link_id='wl_c';
  select count(*) into v_paid from payments.link_status_history h join payments.payment_links l on l.id=h.link_id
   where l.wompi_link_id='wl_c' and h.to_status='paid';
  select status into v_status from payments.payment_links where wompi_link_id='wl_c';
  raise notice 'llamadas=% processed=% duplicate_payment=% duplicate=% tx_distintas=% transiciones_a_paid=% estado=%',
    v_total, v_proc, v_dup_pay, v_dup, v_tx, v_paid, v_status;
  if v_total <> 16 or v_proc <> 1 or v_dup_pay <> v_tx - 1 or v_proc + v_dup_pay + v_dup <> 16 or v_paid <> 1 or v_status <> 'paid' then
    raise exception 'FAIL: record_event concurrente';
  end if;
  raise notice 'PASS: 16 eventos concurrentes -> 1 processed, % duplicate_payment (uno por cada otra tx), resto duplicate, 1 sola transicion a paid', v_dup_pay;
end $$;
