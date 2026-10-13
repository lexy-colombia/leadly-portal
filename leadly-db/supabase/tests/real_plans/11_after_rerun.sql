set client_min_messages = notice;
do $$
begin
  perform t.chk('R1 tras 3 corridas: 7 planes', (select count(*) from public.billing_plans) = 7);
  perform t.chk('R2 tras 3 corridas: modulos 12/16/19 sin duplicados',
    (select count(*) from public.billing_plan_modules) = 47);
  perform t.chk('R3 tras 3 corridas: huella tenant_enabled_modules', t.fp('tem') = (select h from t.fp_before where k = 'tem'));
  perform t.chk('R4 tras 3 corridas: huella subs', t.fp('subs') = (select h from t.fp_before where k = 'subs'));
  perform t.chk('R5 tras 3 corridas: huella facturas', t.fp('inv') = (select h from t.fp_before where k = 'inv'));
  perform t.chk('R6 tras 3 corridas: huella planes de prueba', t.fp('test_plans') = (select h from t.fp_before where k = 'test_plans'));
  perform t.chk('R7 tras 3 corridas: los reales no fueron renombrados a _prueba',
    (select count(*) from public.billing_plans where key in ('starter','business','business_ai','enterprise')) = 4
    and (select count(*) from public.billing_plans where key like '%\_prueba') = 3);
end $$;
