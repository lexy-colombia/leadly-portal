-- F2 ronda 2 / M3 — Corrección de destino de un pedido YA confirmado, ATÓMICA.
--
-- Antes: calculate-order hacía UPDATE del pedido y luego INSERT de la auditoría
-- en dos viajes, con una reversa manual si el segundo fallaba (si la función
-- moría en medio quedaba un cambio de destino sin rastro). Ahora todo ocurre en
-- UNA función/transacción: bloqueo de la fila del pedido, UPDATE de
-- shipping_address_id + shipping_snapshot e INSERT en
-- sales_order_shipping_corrections. Cualquier error revierte las dos cosas.
--
-- Quién puede llamarla: solo service_role (la Edge Function calculate-order,
-- que antes exige el permiso sales.correct_shipping y el motivo con el JWT del
-- usuario; `p_corrected_by` es el id de ese usuario). El candado de la base
-- (factura sent/accepted, 20261112125000) sigue aplicando al UPDATE: si el
-- pedido está facturado, la función falla y no deja nada escrito.
create or replace function public.correct_order_shipping(
  p_tenant_id uuid,
  p_order_id uuid,
  p_new_address_id uuid,
  p_reason text,
  p_corrected_by uuid,
  -- Destino de UN SOLO USO (no guardado en la libreta): se usa solo si
  -- p_new_address_id es null. Claves: recipient_name, phone, line1 (obligatoria),
  -- line2, city, state_province, country, postal_code, city_code, state_code, notes.
  p_new_destination jsonb default null
)
returns public.sales_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_order public.sales_orders;
  v_addr public.contact_addresses;
  v_snapshot jsonb := null;
begin
  if p_reason is null or length(btrim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: el motivo de la corrección es obligatorio.' using errcode = '22023';
  end if;

  select * into v_order from public.sales_orders
   where id = p_order_id and tenant_id = p_tenant_id and deleted_at is null
   for update;
  if not found then
    raise exception 'LX404: pedido no encontrado' using errcode = 'LX404';
  end if;
  if v_order.status <> 'confirmada' then
    raise exception 'LX409: solo se corrige el destino de un pedido confirmado' using errcode = 'LX409';
  end if;

  if p_new_address_id is not null then
    select * into v_addr from public.contact_addresses
     where id = p_new_address_id and tenant_id = p_tenant_id and deleted_at is null;
    if not found then
      raise exception 'LX404: dirección no encontrada' using errcode = 'LX404';
    end if;
    if v_addr.contact_id is distinct from v_order.contact_id then
      raise exception 'SHIPPING_ADDRESS_OWNER: la dirección de envío % no pertenece al cliente % de este tenant.', v_addr.id, v_order.contact_id
        using errcode = '23503', constraint = 'shipping_address_owner';
    end if;
    v_snapshot := jsonb_build_object(
      'address_id', v_addr.id, 'recipient_name', v_addr.recipient_name, 'phone', v_addr.phone,
      'line1', v_addr.line1, 'line2', v_addr.line2, 'city', v_addr.city, 'state_province', v_addr.state_province,
      'country', v_addr.country, 'postal_code', v_addr.postal_code, 'city_code', v_addr.city_code,
      'state_code', v_addr.state_code, 'notes', v_addr.notes, 'frozen_at', now()
    );
  elsif p_new_destination is not null then
    if jsonb_typeof(p_new_destination) <> 'object' or coalesce(btrim(p_new_destination ->> 'line1'), '') = '' then
      raise exception 'SHIPPING_ADDRESS_REQUIRED: el destino puntual necesita una dirección (line1).' using errcode = '22023';
    end if;
    v_snapshot := jsonb_build_object(
      'address_id', null,
      'recipient_name', p_new_destination ->> 'recipient_name', 'phone', p_new_destination ->> 'phone',
      'line1', btrim(p_new_destination ->> 'line1'), 'line2', p_new_destination ->> 'line2',
      'city', p_new_destination ->> 'city', 'state_province', p_new_destination ->> 'state_province',
      'country', p_new_destination ->> 'country', 'postal_code', p_new_destination ->> 'postal_code',
      'city_code', p_new_destination ->> 'city_code', 'state_code', p_new_destination ->> 'state_code',
      'notes', p_new_destination ->> 'notes', 'one_off', true, 'frozen_at', now()
    );
  elsif v_order.fulfillment_method = 'delivery' then
    raise exception 'SHIPPING_ADDRESS_REQUIRED: un pedido a domicilio necesita una dirección de entrega.' using errcode = '22023';
  end if;

  update public.sales_orders
     set shipping_address_id = p_new_address_id, shipping_snapshot = v_snapshot
   where id = v_order.id;

  insert into public.sales_order_shipping_corrections (
    tenant_id, order_id, corrected_by, reason,
    previous_shipping_address_id, previous_shipping_snapshot, new_shipping_address_id, new_shipping_snapshot
  ) values (
    p_tenant_id, v_order.id, p_corrected_by, btrim(p_reason),
    v_order.shipping_address_id, v_order.shipping_snapshot, p_new_address_id, v_snapshot
  );

  select * into v_order from public.sales_orders where id = p_order_id;
  return v_order;
end;
$$;

revoke execute on function public.correct_order_shipping(uuid, uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.correct_order_shipping(uuid, uuid, uuid, text, uuid, jsonb) to service_role;
