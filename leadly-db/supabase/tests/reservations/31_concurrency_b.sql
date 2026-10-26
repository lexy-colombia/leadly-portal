do $$
declare v_state text; v_msg text; t0 timestamptz := clock_timestamp(); el numeric;
begin
  begin
    perform public.save_cart_lines(t.id('ck2'), t.id('tk'), '{}'::jsonb, jsonb_build_array(t.line('pk', 1)));
    el := extract(epoch from clock_timestamp() - t0);
    perform t.chk('L1 dos cajas simultaneas: la segunda es rechazada', false, 'la segunda reservo tambien (sobreventa) tras ' || el || 's');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    el := extract(epoch from clock_timestamp() - t0);
    perform t.chk('L1 dos cajas simultaneas: la segunda es rechazada con LX422', v_state = 'LX422', v_state || ' ' || sqlerrm);
    perform t.chk('L2 la segunda ESPERO al lock de la primera (>1s)', el > 1, 'espero ' || el || 's');
  end;
  perform t.chk('L3 solo una reserva sobrevive', (select coalesce(sum(quantity), 0) from public.stock_reservations where tenant_id = t.id('tk')) = 1);
end $$;
