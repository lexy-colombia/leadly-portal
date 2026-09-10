-- Primer rechazo real de la DIAN sobre una factura de habilitación
-- (2026-09-09, 27 reglas distintas entre rechazos y notificaciones) reveló
-- que faltan los códigos DANE (municipio + departamento) tanto del emisor
-- como del comprador -- exigidos por las reglas FAJ08/FAJ09/FAJ12/FAJ28/
-- FAJ29/FAJ32 (emisor, rechazo real) y FAK09/FAK29/FAK32 (receptor,
-- algunas rechazo) del Anexo Técnico v1.9 (confirmado contra el PDF
-- oficial, sección de reglas de validación de AccountingSupplierParty/
-- AccountingCustomerParty). No existía ningún catálogo DIVIPOLA cargado en
-- el proyecto -- se agrega como campo manual (el tenant/cliente lo conoce
-- de su propio RUT o dirección registrada), no como catálogo autocompletado
-- -- transcribir mal 1122 códigos de municipio a mano sería peor que no
-- tener el dato.
alter table public.tenant_dian_profile add column if not exists city_code text;
alter table public.tenant_dian_profile add column if not exists state_code text;
comment on column public.tenant_dian_profile.city_code is 'Código DANE del municipio (DIVIPOLA), ej. 11001 para Bogotá -- exigido por la DIAN en cac:PhysicalLocation/cac:Address/cbc:ID y cac:PartyTaxScheme/cac:RegistrationAddress/cbc:ID del emisor (reglas FAJ09/FAJ29, rechazo).';
comment on column public.tenant_dian_profile.state_code is 'Código DANE del departamento (DIVIPOLA), ej. 11 para Bogotá D.C. -- exigido en cbc:CountrySubentityCode del emisor (reglas FAJ12/FAJ32, rechazo).';

-- Mismo dato para la dirección del comprador -- acá la regla equivalente
-- (FAK09/FAK29/FAK32) es rechazo solo para RegistrationAddress (FAK29/
-- FAK32), notificación para PhysicalLocation (FAK09) -- igual se agrega el
-- campo para las dos direcciones de golpe, nullable: mientras un cliente no
-- lo tenga cargado, esos dos elementos del XML simplemente no se emiten (no
-- se inventa un valor), lo que puede seguir generando ese rechazo puntual
-- hasta que se cargue -- gap conocido y documentado, no silencioso.
alter table public.contact_addresses add column if not exists city_code text;
alter table public.contact_addresses add column if not exists state_code text;
comment on column public.contact_addresses.city_code is 'Código DANE del municipio (DIVIPOLA) de esta dirección -- ver tenant_dian_profile.city_code para el mismo concepto del lado del emisor.';
comment on column public.contact_addresses.state_code is 'Código DANE del departamento (DIVIPOLA) de esta dirección -- ver tenant_dian_profile.state_code.';
