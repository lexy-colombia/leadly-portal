-- La tienda pública (storefront) tenía su propio modelo de carrito
-- (storefront_carts/storefront_cart_items, 20260826000005), construido
-- antes de que existiera `carts`/`cart_items` (20260904145708 -- el
-- carrito real compartido entre Órdenes del portal y POS). Con `carts`
-- ya existiendo, no hace falta un segundo modelo de "carrito" en la base
-- -- se reapunta la tienda pública a las mismas tablas.
--
-- `calculate-order`/`create-order` siguen sin poder servir al visitante
-- anónimo (exigen JWT de un usuario con profiles.tenant_id) -- la función
-- `storefront` sigue siendo la única puerta, solo que ahora escribe
-- contra `carts`/`cart_items` en vez de las tablas propias.

alter table public.carts drop constraint carts_origin_check;
alter table public.carts add constraint carts_origin_check
  check (origin in ('portal', 'pos', 'storefront'));

-- Identidad del carrito de un visitante anónimo -- vive en su localStorage,
-- mismo rol que ya cumplía storefront_carts.session_token. Nullable: solo
-- lo usan las filas origin='storefront', portal/POS nunca lo necesitan.
-- Sin default de tabla a propósito -- lo genera la Edge Function al crear
-- el carrito (mismo criterio que ya usa para el código OTP), no algo que
-- deba correr también para un carrito de staff.
alter table public.carts add column session_token text unique;

-- Preserva la consulta de "carrito abandonado" que storefront_carts ya
-- ofrecía (storefront_carts_abandoned_idx) -- la métrica en sí sigue sin
-- UI (pendiente explícito), pero la tabla no debe perder la capacidad de
-- soportarla sin trabajo extra.
create index carts_storefront_abandoned_idx on public.carts(tenant_id, created_at)
  where origin = 'storefront' and status = 'open';

-- storefront_phone_verifications es estado de verificación OTP, no de
-- carrito -- se queda como tabla propia, solo se repuntúa a qué apunta.
-- Las filas existentes son verificaciones de prueba atadas a los
-- storefront_carts sintéticos que se borran abajo -- ninguna referencia un
-- carrito real, no hay nada que preservar repuntando fila por fila.
delete from public.storefront_phone_verifications;

alter table public.storefront_phone_verifications drop constraint storefront_phone_verifications_cart_id_fkey;
alter table public.storefront_phone_verifications add constraint storefront_phone_verifications_cart_id_fkey
  foreign key (cart_id) references public.carts(id) on delete cascade;

-- Nada de datos reales detrás -- solo carritos de prueba sintéticos de
-- sesiones anteriores (confirmado antes de este drop).
drop table public.storefront_cart_items;
drop table public.storefront_carts;
