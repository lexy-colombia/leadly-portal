begin;
select public.save_cart_lines(t.id('ck1'), t.id('tk'), '{}'::jsonb, jsonb_build_array(t.line('pk', 1)));
select pg_sleep(3);
commit;
