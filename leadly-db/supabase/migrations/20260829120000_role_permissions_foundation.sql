-- Roles y permisos granulares por acción (pedido explícito del usuario,
-- 2026-08-29): hasta ahora `profiles.role` solo distingue superadmin de
-- "todo lo demás" -- tenant_admin y tenant_agent son indistinguibles tanto
-- en las rutas de /app como en RLS, un agente tiene el mismo CRUD que un
-- admin sobre todo el tenant. `tenant_enabled_modules` prende/apaga un
-- módulo entero, pero es igual para todos los usuarios del tenant, no por
-- rol. El usuario quiere permisos por ACCIÓN dentro de cada módulo (ver/
-- crear/editar/eliminar clientes, no "puede ver Clientes sí/no"), y que
-- cada tenant cree sus propios roles (ej. "Vendedor", "Soporte") con el
-- subconjunto de acciones que quiera -- no un tenant_agent monolítico.
--
-- tenant_admin se mantiene igual que hoy: un rol "dueño" fijo con acceso
-- total no editable (Integraciones/Facturación/Configuración de empresa/
-- gestión de usuarios y roles siguen admin-only, fuera de este sistema).
-- Los roles personalizados aplican solo a usuarios tenant_agent, sobre los
-- módulos operativos del negocio.
--
-- Cuatro piezas, mismo template que tenant_enabled_modules/ai_skills:
--   permission_actions      -- catálogo fijo de acciones posibles (de código,
--                               igual que ai_skills: nadie lo edita desde la UI).
--   tenant_roles             -- los roles que cada tenant crea. A diferencia
--                               de tenant_enabled_modules/ai_assistant_skills
--                               (superadmin-only write), el tenant SE
--                               AUTOGESTIONA esto -- is_tenant_admin() puede
--                               escribir sobre su propio tenant. Tiene
--                               identidad de negocio real (un usuario queda
--                               asignado a la fila) -> soft-delete, no DELETE.
--   tenant_role_permissions  -- bridge presence-based (rol x acción), sin
--                               identidad propia -> DELETE real al desmarcar,
--                               igual que ai_assistant_skills.
--   profiles.tenant_role_id  -- a qué rol de su tenant pertenece un
--                               tenant_agent (tenant_admin/superadmin lo
--                               ignoran, siempre tienen todo).

create table public.permission_actions (
  key text primary key,
  module_key text not null,
  name text not null,
  description text,
  display_order int not null default 0,
  created_at timestamptz not null default now()
);

alter table public.permission_actions enable row level security;

create policy permission_actions_select on public.permission_actions
  for select to authenticated using (true);

create policy permission_actions_superadmin_write on public.permission_actions
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

create table public.tenant_roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  name text not null,
  description text,
  created_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz,
  deleted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tenant_roles_tenant_idx on public.tenant_roles(tenant_id);
-- Nombres únicos entre roles vivos del mismo tenant -- un rol borrado
-- (soft-delete) no debe bloquear reusar su nombre.
create unique index tenant_roles_tenant_name_idx on public.tenant_roles(tenant_id, name) where deleted_at is null;

create trigger tenant_roles_set_updated_at
  before update on public.tenant_roles
  for each row execute function public.set_updated_at();

alter table public.tenant_roles enable row level security;

create policy tenant_roles_select on public.tenant_roles
  for select to authenticated using (
    public.is_superadmin() or tenant_id = public.auth_active_tenant_id()
  );

create policy tenant_roles_insert on public.tenant_roles
  for insert to authenticated with check (
    public.is_superadmin() or (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin())
  );

create policy tenant_roles_update on public.tenant_roles
  for update to authenticated using (
    public.is_superadmin() or (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin())
  ) with check (
    public.is_superadmin() or (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin())
  );

create policy tenant_roles_delete on public.tenant_roles
  for delete to authenticated using (
    public.is_superadmin() or (tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin())
  );

create table public.tenant_role_permissions (
  id uuid primary key default gen_random_uuid(),
  tenant_role_id uuid not null references public.tenant_roles(id) on delete cascade,
  action_key text not null references public.permission_actions(key) on delete restrict,
  granted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_role_id, action_key)
);

create index tenant_role_permissions_role_idx on public.tenant_role_permissions(tenant_role_id);

alter table public.tenant_role_permissions enable row level security;

create policy tenant_role_permissions_select on public.tenant_role_permissions
  for select to authenticated using (
    public.is_superadmin()
    or exists (
      select 1 from public.tenant_roles r
      where r.id = tenant_role_permissions.tenant_role_id and r.tenant_id = public.auth_active_tenant_id()
    )
  );

create policy tenant_role_permissions_write on public.tenant_role_permissions
  for all to authenticated using (
    public.is_superadmin()
    or exists (
      select 1 from public.tenant_roles r
      where r.id = tenant_role_permissions.tenant_role_id and r.tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin()
    )
  ) with check (
    public.is_superadmin()
    or exists (
      select 1 from public.tenant_roles r
      where r.id = tenant_role_permissions.tenant_role_id and r.tenant_id = public.auth_active_tenant_id() and public.is_tenant_admin()
    )
  );

alter table public.profiles add column tenant_role_id uuid references public.tenant_roles(id) on delete set null;

-- has_permission(): true incondicional para superadmin/tenant_admin (el
-- rol "dueño" no se restringe, ver CLAUDE.md de esta ronda); para
-- tenant_agent, existe la acción en el rol asignado. security definer,
-- mismo patrón que is_tenant_admin() (20260802000002_helpers.sql).
create or replace function public.has_permission(p_action_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    public.is_superadmin()
    or public.is_tenant_admin()
    or exists (
      select 1
      from public.profiles p
      join public.tenant_role_permissions trp on trp.tenant_role_id = p.tenant_role_id
      where p.id = auth.uid() and trp.action_key = p_action_key
    );
$$;

grant execute on function public.has_permission(text) to authenticated;

-- seed_default_tenant_role(): todo tenant nuevo arranca con un rol
-- "Agente" usable desde el día uno, con el catálogo completo otorgado --
-- mismo criterio que seed_default_pipeline()/seed_default_warehouse() (un
-- tenant nunca debería llegar a invitar un agente sin tener ningún rol
-- para asignarle). El tenant_admin lo edita/restringe o crea otros roles
-- después, a mano.
create or replace function public.seed_default_tenant_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role_id uuid;
begin
  insert into public.tenant_roles (tenant_id, name, description)
  values (new.id, 'Agente', 'Rol por defecto con acceso completo a los módulos operativos -- edítalo o creá otros roles según lo que necesites.')
  returning id into v_role_id;

  insert into public.tenant_role_permissions (tenant_role_id, action_key)
  select v_role_id, key from public.permission_actions;

  return new;
end;
$$;

create trigger tenants_seed_default_tenant_role
  after insert on public.tenants
  for each row execute function public.seed_default_tenant_role();

-- Catálogo de acciones (revisado con el usuario antes de esta migración).
insert into public.permission_actions (key, module_key, name, description, display_order) values
  ('conversations.reply', 'conversations', 'Responder conversaciones', 'Enviar mensajes manuales en modo humano.', 1),
  ('conversations.assign', 'conversations', 'Vincular cliente', 'Vincular o crear un cliente desde una conversación.', 2),
  ('conversations.manage_tags', 'conversations', 'Gestionar etiquetas', 'Crear o eliminar etiquetas de conversación.', 3),
  ('conversations.delete', 'conversations', 'Eliminar conversación', 'Eliminar una conversación.', 4),

  ('contacts.view', 'contacts', 'Ver clientes', 'Ver el listado y la ficha de clientes.', 1),
  ('contacts.create', 'contacts', 'Crear clientes', 'Crear un cliente nuevo.', 2),
  ('contacts.edit', 'contacts', 'Editar clientes', 'Editar los datos de un cliente.', 3),
  ('contacts.delete', 'contacts', 'Eliminar clientes', 'Eliminar (soft-delete) un cliente.', 4),
  ('contacts.manage_credit', 'contacts', 'Gestionar crédito', 'Habilitar o deshabilitar crédito de un cliente.', 5),

  ('pipeline.view', 'pipeline', 'Ver oportunidades', 'Ver el pipeline y el detalle de oportunidades.', 1),
  ('pipeline.create', 'pipeline', 'Crear oportunidades', 'Crear una oportunidad nueva.', 2),
  ('pipeline.edit', 'pipeline', 'Editar oportunidades', 'Editar los datos de una oportunidad.', 3),
  ('pipeline.delete', 'pipeline', 'Eliminar oportunidades', 'Eliminar una oportunidad.', 4),
  ('pipeline.change_stage', 'pipeline', 'Cambiar etapa', 'Mover una oportunidad entre etapas del pipeline.', 5),
  ('pipeline.manage_pipelines', 'pipeline', 'Gestionar pipelines', 'Crear o editar pipelines y sus etapas.', 6),

  ('products.view', 'products', 'Ver productos', 'Ver el catálogo de productos.', 1),
  ('products.create', 'products', 'Crear productos', 'Crear un producto nuevo.', 2),
  ('products.edit', 'products', 'Editar productos', 'Editar los datos de un producto.', 3),
  ('products.delete', 'products', 'Eliminar productos', 'Eliminar un producto.', 4),
  ('products.manage_stock', 'products', 'Gestionar inventario', 'Registrar movimientos de stock.', 5),
  ('products.manage_catalog', 'products', 'Gestionar catálogo', 'Crear o editar categorías, marcas y proveedores.', 6),

  ('sales.view', 'sales', 'Ver ventas', 'Ver el listado y detalle de ventas/cotizaciones.', 1),
  ('sales.create', 'sales', 'Crear ventas', 'Crear una venta o cotización nueva.', 2),
  ('sales.edit', 'sales', 'Editar ventas', 'Editar una venta existente.', 3),
  ('sales.delete', 'sales', 'Eliminar ventas', 'Eliminar o cancelar una venta.', 4),
  ('sales.confirm', 'sales', 'Confirmar ventas', 'Confirmar una cotización como venta.', 5),
  ('sales.manage_payments', 'sales', 'Gestionar pagos', 'Registrar pagos sobre una venta.', 6),

  ('credit.view', 'credit', 'Ver cartera', 'Ver cuentas y movimientos de crédito.', 1),
  ('credit.charge', 'credit', 'Cargar a crédito', 'Cargar una venta a la cuenta de crédito de un cliente.', 2),
  ('credit.register_payment', 'credit', 'Registrar pago de cartera', 'Registrar un abono a la cartera de un cliente.', 3),

  ('returns.view', 'returns', 'Ver devoluciones', 'Ver el listado de devoluciones.', 1),
  ('returns.create', 'returns', 'Crear devoluciones', 'Registrar una devolución nueva.', 2),
  ('returns.process', 'returns', 'Procesar devoluciones', 'Aprobar o procesar una devolución.', 3),

  ('calendar.view', 'calendar', 'Ver citas', 'Ver el calendario de citas.', 1),
  ('calendar.create', 'calendar', 'Crear citas', 'Agendar una cita nueva.', 2),
  ('calendar.edit', 'calendar', 'Editar citas', 'Editar o reagendar una cita.', 3),
  ('calendar.cancel', 'calendar', 'Cancelar citas', 'Cancelar una cita.', 4),

  ('tasks.view', 'tasks', 'Ver tareas', 'Ver el listado de tareas.', 1),
  ('tasks.create', 'tasks', 'Crear tareas', 'Crear una tarea nueva.', 2),
  ('tasks.edit', 'tasks', 'Editar tareas', 'Editar una tarea existente.', 3),
  ('tasks.delete', 'tasks', 'Eliminar tareas', 'Eliminar una tarea.', 4),
  ('tasks.complete', 'tasks', 'Completar tareas', 'Marcar una tarea como completada.', 5),

  ('campaigns.view', 'campaigns', 'Ver campañas', 'Ver el listado de campañas.', 1),
  ('campaigns.create', 'campaigns', 'Crear campañas', 'Crear o editar una campaña.', 2),
  ('campaigns.delete', 'campaigns', 'Eliminar campañas', 'Eliminar una campaña.', 3),
  ('campaigns.send', 'campaigns', 'Enviar campañas', 'Lanzar el envío de una campaña.', 4),

  ('aiAgents.view', 'aiAgents', 'Ver asistentes de IA', 'Ver los asistentes de IA y sus líneas asignadas.', 1),
  ('aiAgents.manage', 'aiAgents', 'Gestionar asistentes de IA', 'Crear/editar asistentes, sus habilidades y su asignación a líneas.', 2);

-- Backfill: cada tenant existente recibe su rol "Agente" con el catálogo
-- completo (mismo criterio que el backfill de ai_assistant_skills 'pqr' --
-- sin esto, todo tenant_agent actual perdería acceso de golpe el día del
-- deploy, ya que hoy tiene acceso total de facto). El tenant_admin lo
-- restringe después a mano.
do $$
declare
  t record;
  v_role_id uuid;
begin
  for t in select id from public.tenants loop
    insert into public.tenant_roles (tenant_id, name, description)
    values (t.id, 'Agente', 'Rol por defecto con acceso completo a los módulos operativos -- edítalo o creá otros roles según lo que necesites.')
    returning id into v_role_id;

    insert into public.tenant_role_permissions (tenant_role_id, action_key)
    select v_role_id, key from public.permission_actions;

    update public.profiles set tenant_role_id = v_role_id
    where tenant_id = t.id and role = 'tenant_agent';
  end loop;
end;
$$;
