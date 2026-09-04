-- Flag simple de retención por cliente -- la retención en la fuente
-- (ReteIVA/ReteFuente/ReteICA) depende del estatus del COMPRADOR (gran
-- contribuyente, agente autorretenedor, agente de retención designado), no
-- de qué producto se vendió. Deliberadamente simple: no se modela todo el
-- árbol de responsabilidades tributarias (determinar automáticamente cuál
-- aplica requeriría consultar el RUT del cliente contra la DIAN, fuera de
-- alcance) -- el tenant (o su contador) marca el flag manualmente.
alter table public.clients add column applies_withholding boolean not null default false;

comment on column public.clients.applies_withholding is 'El tenant marca esto manualmente si este cliente (comprador) es agente retenedor/gran contribuyente y por tanto sus facturas deben incluir retención -- no se infiere automáticamente del RUT, el tenant lo confirma con su cliente/contador.';
