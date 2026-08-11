-- "Habilidades" catalog: generalizes the PQR tool-calling that used to be
-- hardcoded into every assistant's hand-written system_prompt (see the
-- "Tenant QA Uno" prompt) into a reusable, per-assistant toggle. Two pieces:
--   ai_skills          -- the fixed catalog Leadly defines (new skills always
--                         require new code in _shared/aiTools.ts +
--                         whatsapp-ai-tools anyway, so this table only holds
--                         the *display* + *prompt* side, never the tool
--                         implementation itself).
--   ai_assistant_skills -- which skills are turned on for a given assistant
--                         (one per whatsapp_line, see ai_assistants). A pure
--                         many-to-many bridge with no business identity of
--                         its own, so "disabling" a skill is a real DELETE,
--                         not a soft-delete (same exception already applied
--                         to conversation_tag_assignments -- see CLAUDE.md
--                         section 3, "borrado siempre es soft-delete").
create table public.ai_skills (
  id uuid primary key default gen_random_uuid(),
  key text unique not null,
  name text not null,
  description text not null,
  prompt_fragment text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.ai_assistant_skills (
  id uuid primary key default gen_random_uuid(),
  ai_assistant_id uuid not null references public.ai_assistants(id) on delete cascade,
  skill_key text not null references public.ai_skills(key) on delete restrict,
  enabled_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (ai_assistant_id, skill_key)
);

create index ai_assistant_skills_assistant_idx on public.ai_assistant_skills(ai_assistant_id);

alter table public.ai_skills enable row level security;
alter table public.ai_assistant_skills enable row level security;

-- Every authenticated user can read the catalog (needed to render names in
-- the tenant's own "Asistentes de IA" summary later, not just backoffice).
create policy ai_skills_select on public.ai_skills
  for select to authenticated using (true);

-- Only superadmin manages the catalog itself (adding a new skill is a code
-- change anyway -- create_pqr etc. must exist in whatsapp-ai-tools first).
create policy ai_skills_superadmin_write on public.ai_skills
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

-- Enabling/disabling a skill for a specific assistant is a superadmin action
-- (see CLAUDE.md: the tenant doesn't self-serve this, Leadly turns it on for
-- them) -- tenants can still SELECT so their own Configuración screen can
-- show what's active on their line, read-only.
create policy ai_assistant_skills_select on public.ai_assistant_skills
  for select to authenticated using (
    public.is_superadmin()
    or exists (
      select 1 from public.ai_assistants a
      where a.id = ai_assistant_skills.ai_assistant_id
      and a.whatsapp_line_id in (select id from public.whatsapp_lines where tenant_id = public.auth_tenant_id())
    )
  );

create policy ai_assistant_skills_superadmin_write on public.ai_assistant_skills
  for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());

insert into public.ai_skills (key, name, description, prompt_fragment) values (
  'pqr',
  'Gestión de PQR',
  'El asistente puede crear y dar seguimiento a Peticiones, Quejas y Reclamos formales del cliente, consultar su estado, y reenviar adjuntos de un caso.',
  'Tenés herramientas disponibles para actuar sobre el caso del cliente -- úsalas en el momento correcto, sin anunciar ni explicar que las estás usando: simplemente actuá y después contale al cliente el resultado en lenguaje natural.

- create_pqr: cuando el cliente exprese una queja, un reclamo, o haga una petición formal que necesite seguimiento de un agente humano. Después de crearla, decile al cliente el código que te devuelve la herramienta (por ejemplo: "tu caso quedó registrado como PQR-7").
- add_pqr_update: cuando el cliente vuelva a escribir sobre un caso que ya había reportado antes (para dar más información o preguntar de nuevo por lo mismo).
- get_pqr_status: cuando el cliente pregunte cómo va su caso, pida el código de su PQR, o pregunte por el estado de un reclamo anterior. Si no tiene ningún PQR todavía, decíselo con naturalidad.
- update_pqr_status: solo cuando el cliente confirme explícitamente que su caso ya se resolvió, o pida cancelarlo. Nunca cambies el estado por tu cuenta sin esa confirmación explícita.
- create_note: para información útil que el cliente comparta y que no amerite un PQR formal.

Si el cliente te manda una foto, no podés ver su contenido (todavía no tenés visión) -- se guarda automáticamente adjunta al PQR o seguimiento que estés creando o actualizando en ese momento, así que no hace falta que hagas nada especial con el archivo en sí. Si la foto llega sin ningún texto que explique de qué se trata, preguntale al cliente qué es o para qué caso es -- nunca asumas ni inventes qué muestra la imagen.

get_pqr_status también te dice, junto con el PQR y sus últimos seguimientos, si hay imágenes adjuntas (attachments, con su id) -- por ejemplo un comprobante de reembolso. Si el cliente pide ver, que le compartas, o pregunta si hay una foto o un soporte de su caso, primero llamá a get_pqr_status para revisar esa lista, y si hay algo, usá send_attachment con el attachment_id correspondiente para enviárselo directo por WhatsApp. Solo podés enviar adjuntos del caso más reciente del cliente.'
);

-- Backfill: every assistant that exists today was already able to use these
-- tools unconditionally (the old AI_TOOLS array was sent to every assistant
-- regardless of prompt content) -- enable 'pqr' for all of them so nothing
-- regresses the moment tool access starts being gated by this table. New
-- assistants created after this migration start with zero skills, an
-- explicit superadmin choice from here on.
insert into public.ai_assistant_skills (ai_assistant_id, skill_key)
select id, 'pqr' from public.ai_assistants;
