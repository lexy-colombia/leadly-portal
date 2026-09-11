-- Bug real de producción, reportado por el usuario: "cuando elimino un pago
-- sigo viendolo en el detalle, no se elimina". El botón de borrar SÍ se
-- mostraba (RLS ya lo permite, ver 20260911193000) y el frontend cerraba el
-- diálogo de confirmación sin ningún error visible -- pero el pago seguía
-- ahí después de recargar la lista.
--
-- Causa raíz: `guard_sales_order_payment_immutable()` (20260822020001,
-- ANTERIOR a que existiera el permiso `sales.edit_invoiced_order`) es un
-- trigger BEFORE UPDATE/DELETE que revienta con una excepción para
-- CUALQUIER pago de una orden que no esté en 'cotizacion', sin excepción --
-- nunca se enteró de que el 2026-09-11 se agregó un permiso explícito para
-- que un admin (o quien tenga ese permiso) pudiera editar pagos de una
-- orden ya confirmada. La RLS (`can_edit_confirmed_sales_order`, misma
-- fecha) sí lo permitía, pero este trigger corre igual y bloquea antes de
-- que la RLS importe. Como `deletePayment()`/`updatePaymentMethod()` hacen
-- un `.update()` sin `.select()`, Supabase no arrojaba error del lado del
-- cliente en algunos casos, o el error quedaba absorbido en el catch de
-- `handleDeletePayment` (ver fix de frontend en el mismo commit) -- el pago
-- nunca se tocaba y la UI no explicaba por qué.
--
-- Fix: el trigger delega en la MISMA función que ya usa la RLS
-- (`can_edit_confirmed_sales_order`), en vez de tener su propio criterio
-- desalineado -- una sola fuente de verdad para "¿se puede tocar este pago
-- ahora?". Sigue bloqueando sin excepción a las órdenes despachadas o
-- anuladas (esa función ya lo hace).
create or replace function public.guard_sales_order_payment_immutable()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.can_edit_confirmed_sales_order(old.order_id) then
    raise exception 'No se puede modificar ni eliminar este pago (orden despachada o anulada, o falta el permiso para editar una orden ya confirmada)';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
