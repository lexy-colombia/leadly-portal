-- Permite que un tenant_admin edite el perfil de su propia empresa (razón
-- social, documento, contacto, dirección, etc.) desde /app/configuracion --
-- hasta ahora `tenants` solo tenía policy de UPDATE para superadmin
-- (tenants_superadmin_update), así que aunque la UI mostrara estos campos
-- (2026-08-16, ver Configuracion.tsx) el guardado hubiera fallado por RLS
-- para cualquier tenant real, igual que pasó con el logo.
--
-- Mismo patrón de "defense in depth" que prevent_profile_privilege_escalation
-- (20260802000007): la policy de RLS solo exige que sea su propio tenant y
-- que sea tenant_admin, pero un trigger aparte bloquea columnas sensibles
-- (status, id, created_at) que un self-service update nunca debería poder
-- tocar aunque alguien arme la request a mano (bypasseando el frontend, que
-- ya no las expone vía TenantInput). status en particular es crítico: un
-- tenant desactivado no debería poder reactivarse a sí mismo.

create policy tenants_self_update on public.tenants
  for update using (id = public.auth_tenant_id() and public.is_tenant_admin())
  with check (id = public.auth_tenant_id() and public.is_tenant_admin());

create or replace function public.prevent_tenant_self_service_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_superadmin() then
    return new;
  end if;

  if new.status is distinct from old.status
    or new.id is distinct from old.id
    or new.created_at is distinct from old.created_at
  then
    raise exception 'Not authorized to change status/id/created_at on this tenant';
  end if;

  return new;
end;
$$;

create trigger tenants_prevent_self_service_escalation
  before update on public.tenants
  for each row execute function public.prevent_tenant_self_service_escalation();
