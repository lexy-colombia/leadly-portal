-- Limpieza de los datos de PRUEBA de Wompi del flujo anterior (2026-08-25 .. 2026-09-14),
-- tenant TecnoNova Colombia (QA): 13 filas de public.sales_order_payment_links y los 6
-- pagos Wompi de sandbox que acreditaron (public.sales_order_payments, method='wompi').
-- Pedido explicito del usuario (2026-10-16): "todos los links y pagos son de prueba".
-- La tabla sales_order_payment_links se elimina en la migracion de retiro de legacy
-- (ST5); esta corre ANTES (timestamp menor) y deja sus filas en cero.
--
-- Los pagos de un pedido que ya no esta en 'cotizacion' son inmutables por el trigger
-- trg_sales_order_payments_immutable_delete (proteccion contable real). Se deshabilita
-- SOLO ese trigger, SOLO dentro de esta transaccion, y se vuelve a habilitar antes de
-- salir; cualquier fallo revierte todo (DDL transaccional).
--
-- Acotado por ids exactos verificados antes de escribir la migracion. Aborta si algo no
-- coincide: otro pago wompi, otro link, otro tenant, un pago con cargo a credito o saldo a
-- favor dependiente (FK en cascada), o una factura enviada/aceptada de esos pedidos.
-- En una base donde esos datos no existen (local, otro ambiente) no hace nada.
do $$
declare
  c_tenant constant uuid := 'cb195047-8cd2-4e38-9964-62bb99911814';
  c_payments constant uuid[] := array[
    'a7e71715-1231-476e-be15-9460d9d9174c', 'be8f6620-7425-44d2-bb43-038a03eac067',
    '2dfeb904-009d-4f85-a74e-8fde4fe5f3b9', '5c8b96b5-e3dd-4dee-803a-4d2284f1f06d',
    '7ef107be-2bee-4f90-96cb-f347a89344e6', '8202284f-f36a-4929-ac30-116f6a0d14ca'
  ]::uuid[];
  c_links constant uuid[] := array[
    '48508231-fbdb-4a50-bf5b-b8da4b329ec9', '9fde9d59-73ef-42e9-913d-8632d8a86f3c',
    'bfdfa8ee-e2e2-44a1-8e12-ee0320fc5c21', 'f4281d47-c463-40d4-ab26-36501138de02',
    '1ef6b160-7051-41d0-ae5f-e9ac7637b74c', '5080742d-1564-4b1a-887f-f92cbfc89688',
    '5a7b818e-598c-47c3-81d6-d79a3289e058', '89876270-5f9a-42ec-9c73-98aa15fdcac6',
    'cb098b34-56c6-4815-a71a-ee8078bc6d82', 'd564272d-d72a-4130-88d0-c13eff031241',
    'f4f7480f-fe39-41ef-ae18-7bc088dfec56', 'f99fd298-115b-446e-bdeb-904649a11870',
    'af1fe37d-42b2-44fb-a73a-80a9d2b56743'
  ]::uuid[];
  v_pay_found int;
  v_pay_total int;
  v_link_found int;
  v_link_total int;
begin
  select count(*) into v_pay_found from public.sales_order_payments where id = any (c_payments);
  select count(*) into v_link_found from public.sales_order_payment_links where id = any (c_links);

  if v_pay_found = 0 and v_link_found = 0 then
    raise notice 'remove_sandbox_wompi_test_data: no hay datos de prueba que limpiar; no se hace nada.';
    return;
  end if;
  if v_pay_found <> 6 or v_link_found <> 13 then
    raise exception 'remove_sandbox_wompi_test_data: encontrados % pagos y % links de los esperados (6 y 13); se aborta.', v_pay_found, v_link_found;
  end if;

  -- no debe haber NINGUN otro pago wompi ni otro link en toda la base
  select count(*) into v_pay_total from public.sales_order_payments where method = 'wompi' or provider_key = 'wompi';
  select count(*) into v_link_total from public.sales_order_payment_links;
  if v_pay_total <> 6 or v_link_total <> 13 then
    raise exception 'remove_sandbox_wompi_test_data: hay pagos/links wompi fuera de la lista (pagos=%, links=%); se aborta.', v_pay_total, v_link_total;
  end if;

  -- mismo tenant (QA) y todos de sandbox/wompi
  if exists (select 1 from public.sales_order_payments where id = any (c_payments)
              and (tenant_id <> c_tenant or method <> 'wompi' or provider_key is distinct from 'wompi' or deleted_at is not null)) then
    raise exception 'remove_sandbox_wompi_test_data: un pago no es del tenant/metodo esperado; se aborta.';
  end if;
  if exists (select 1 from public.sales_order_payment_links where id = any (c_links)
              and (tenant_id <> c_tenant or provider_key <> 'wompi' or provider_checkout_id not like 'test\_%')) then
    raise exception 'remove_sandbox_wompi_test_data: un link no es del tenant/proveedor esperado o no es de prueba; se aborta.';
  end if;

  -- dependientes en cascada: ninguno permitido
  if exists (select 1 from public.credit_charges where sales_order_payment_id = any (c_payments))
     or exists (select 1 from public.store_credit_redemptions where sales_order_payment_id = any (c_payments)) then
    raise exception 'remove_sandbox_wompi_test_data: hay cargos a credito o saldos a favor dependientes de esos pagos; se aborta.';
  end if;

  -- nunca se toca un pedido con documento electronico ya transmitido a la DIAN
  if exists (select 1 from public.sales_invoices i
              where i.status in ('sent', 'accepted')
                and i.order_id in (select order_id from public.sales_order_payments where id = any (c_payments))) then
    raise exception 'remove_sandbox_wompi_test_data: un pedido afectado tiene factura enviada/aceptada ante la DIAN; se aborta.';
  end if;

  alter table public.sales_order_payments disable trigger trg_sales_order_payments_immutable_delete;
  delete from public.sales_order_payments where id = any (c_payments);
  alter table public.sales_order_payments enable trigger trg_sales_order_payments_immutable_delete;

  delete from public.sales_order_payment_links where id = any (c_links);

  raise notice 'remove_sandbox_wompi_test_data: eliminados 6 pagos y 13 links de prueba.';
end
$$;
