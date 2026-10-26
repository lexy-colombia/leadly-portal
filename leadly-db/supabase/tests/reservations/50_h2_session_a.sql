-- Sesion A: autosave del POS (save_cart_lines) sobre la cuenta, arranca 0.5s despues.
select pg_sleep(0.5);
select 'A_RESULT ' || coalesce((select 'ok' from (select public.save_cart_lines(t.id('cd'), t.id('td'), '{}'::jsonb, jsonb_build_array(t.line('pd1', 2), t.line('pd2', 2)))) s), 'x');
