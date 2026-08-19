-- Mejoras a warehouses/stock_movements (Inventario Fase 1), backend puro --
-- ningún cambio de frontend implicado, las pantallas de Bodegas siguen
-- funcionando con los mismos campos que ya conocían más los nuevos abajo.
--
-- warehouses gana city/type/manager_name/phone: hoy una bodega es solo
-- nombre+dirección+default/activa, sin forma de distinguir una bodega real
-- de un punto de venta ni de saber a quién contactar. `type` distingue
-- bodega/punto_venta/transito -- relevante para Fase 2 (Despachos): un
-- despacho puede salir de una bodega o de un punto de venta, no son lo
-- mismo operativamente.
--
-- stock_movements gana unit_cost: un kardex sin costo por movimiento no
-- sirve para valorar inventario (costo de mercancía vendida, márgenes) --
-- necesario tarde o temprano para Facturas/Cartera, mejor tenerlo desde
-- ahora que agregarlo después con movimientos ya existentes sin costo.

alter table public.warehouses
  add column city text,
  add column type text not null default 'bodega' check (type in ('bodega', 'punto_venta', 'transito')),
  add column manager_name text,
  add column phone text;

alter table public.stock_movements
  add column unit_cost numeric;

comment on column public.warehouses.type is 'bodega: almacenamiento puro. punto_venta: también atiende clientes directamente. transito: bodega temporal/intermedia (ej. en una transferencia).';
comment on column public.stock_movements.unit_cost is 'Costo unitario del movimiento (opcional) -- para valorar inventario y costo de mercancía vendida más adelante. Null en movimientos donde no aplica (ej. un ajuste sin costo conocido).';
