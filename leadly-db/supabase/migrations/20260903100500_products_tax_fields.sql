-- Clasificación de impuesto por producto -- fundamento del cálculo de IVA/INC
-- por línea de venta (facturación electrónica DIAN, fase de cimientos).
-- La tasa es configurable libremente por el tenant (no derivada de un enum
-- fijo) porque el Impuesto Nacional al Consumo tiene tasas variables reales
-- (4%/8%/16% según el bien/servicio), a diferencia del IVA que solo tiene 3
-- valores posibles.
--
-- Default 'IVA 19%' en todo producto existente y nuevo -- sin efecto en el
-- cobro hasta que el tenant active el cálculo de impuestos (tenant_dian_profile.tax_enabled).
alter table public.products
  add column tax_type_code text references public.tax_types(code) default '01',
  add column tax_rate numeric not null default 19;

comment on column public.products.tax_type_code is 'Impuesto que se suma al precio del producto (IVA/INC/ICA -- tax_types.category=impuesto, applies_at=line). Las retenciones no se configuran acá, dependen del comprador, ver tenant_withholding_configs.';
comment on column public.products.tax_rate is 'Tasa porcentual configurable por el tenant -- no se deriva del tax_type_code porque el INC tiene varias tasas posibles (4/8/16%).';
