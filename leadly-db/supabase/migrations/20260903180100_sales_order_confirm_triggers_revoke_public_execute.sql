-- get_advisors flagged (correctamente) que los triggers de
-- 20260903180000 quedaron expuestos como RPC público en
-- /rest/v1/rpc/<nombre> -- todo SECURITY DEFINER en el schema public se
-- auto-expone así por PostgREST salvo que se revoque EXECUTE a propósito.
-- No son explotables de verdad (dependen del contexto NEW/OLD de un
-- trigger real, llamarlas directo revienta), pero no tienen ningún motivo
-- para ser invocables -- se revoca, mismo criterio que cualquier función
-- interna. De paso se cierra el mismo hueco preexistente en
-- apply_sales_order_confirmed_stock_effect (20260825134917), que nunca
-- había tenido este revoke.
-- OJO: revocar de anon/authenticated NO alcanza -- el privilegio efectivo
-- venía de PUBLIC (pseudo-grupo del que todo rol es miembro implícito), no
-- de esos roles directamente; has_function_privilege() seguía dando true
-- hasta corregir esto. Hay que revocar de PUBLIC.
revoke execute on function public.guard_sales_order_confirmation() from public;
revoke execute on function public.apply_sales_order_confirmed_effects() from public;
revoke execute on function public.apply_sales_order_confirmed_stock_effect() from public;
