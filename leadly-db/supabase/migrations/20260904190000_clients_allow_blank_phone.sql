-- Import masivo de clientes de Barriles de la Sexta (POS externo, 2026-09-04):
-- 34 de 39 clientes reales no traen teléfono en el sistema de origen. El
-- usuario pidió explícitamente registrarlos "sin número" en vez de inventar
-- uno ficticio -- pero el índice único (tenant_id, phone_prefix, phone)
-- trataría dos `phone = ''` como duplicados y bloquearía el segundo insert.
-- Se excluye phone = '' de la unicidad (sigue habiendo como mucho un cliente
-- con cada número REAL por tenant, que es lo que la unicidad protegía en
-- realidad -- un teléfono vacío no identifica a nadie).
drop index if exists public.clients_tenant_id_phone_prefix_phone_active_idx;
create unique index clients_tenant_id_phone_prefix_phone_active_idx
  on public.clients(tenant_id, phone_prefix, phone)
  where deleted_at is null and phone <> '';
