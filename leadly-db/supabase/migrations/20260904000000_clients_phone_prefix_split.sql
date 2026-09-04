-- Separa el indicativo de país del número local en clients.phone -- hasta
-- ahora phone guardaba el número completo sin separadores (ej.
-- "573209149704", mismo formato que el wa_id que manda Meta). Pedido
-- explícito del usuario 2026-09-04: la factura electrónica debe mostrar
-- solo el número local, sin indicativo -- clients.phone pasa a ser SOLO el
-- número local, phone_prefix (nueva) guarda el indicativo aparte.
--
-- Mismo catálogo de indicativos que ya usaba el frontend
-- (leadly-app/src/lib/phone.ts, DIAL_CODES) -- replicado acá en SQL, los de
-- 3 dígitos primero, para no partir mal un número ecuatoriano/panameño/
-- costarricense confundiéndolo con el indicativo de 2 dígitos de otro país.
alter table public.clients add column phone_prefix text not null default '57';

update public.clients set
  phone_prefix = case
    when phone like '593%' then '593'
    when phone like '507%' then '507'
    when phone like '506%' then '506'
    when phone like '57%' then '57'
    when phone like '52%' then '52'
    when phone like '34%' then '34'
    when phone like '54%' then '54'
    when phone like '56%' then '56'
    when phone like '51%' then '51'
    when phone like '58%' then '58'
    when phone like '1%' then '1'
    else '57'
  end,
  phone = case
    when phone like '593%' then substring(phone from 4)
    when phone like '507%' then substring(phone from 4)
    when phone like '506%' then substring(phone from 4)
    when phone like '57%' then substring(phone from 3)
    when phone like '52%' then substring(phone from 3)
    when phone like '34%' then substring(phone from 3)
    when phone like '54%' then substring(phone from 3)
    when phone like '56%' then substring(phone from 3)
    when phone like '51%' then substring(phone from 3)
    when phone like '58%' then substring(phone from 3)
    when phone like '1%' then substring(phone from 2)
    else phone
  end
where phone is not null;

-- Reemplaza el índice único (tenant_id, phone) por (tenant_id, phone_prefix,
-- phone) -- sin el indicativo, dos clientes con el mismo número local pero
-- país distinto colisionarían incorrectamente como duplicados.
drop index if exists public.clients_tenant_id_phone_active_idx;
create unique index clients_tenant_id_phone_prefix_phone_active_idx
  on public.clients(tenant_id, phone_prefix, phone) where deleted_at is null;

-- Mismo trigger de normalización que ya limpiaba `phone` a solo-dígitos
-- (normalize_phone_column, 20260819020001) -- se agrega también sobre
-- phone_prefix por si algún día se tipea a mano con un "+" adelante.
create trigger trg_clients_normalize_phone_prefix
  before insert or update of phone_prefix on public.clients
  for each row execute function public.normalize_phone_column('phone_prefix');
