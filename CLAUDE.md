# Leadly — Plataforma multi-tenant de asesores de WhatsApp con IA

> Este archivo es la fuente de verdad técnica del proyecto. El backlog vive en **Linear** (una vez creado) — este documento explica el *por qué* y el *cómo*, Linear lleva el *qué falta*. Historial de decisiones previas en [plan.md](plan.md).

## Estado actual (2026-08-03, actualizado en la sesión de implementación — demo el 2026-08-04)

**Fase 0, Fase 1, Fase 2 (backend + Inbox) y un CRM de contactos completo ya están construidos y probados end-to-end**. Proyecto de Supabase real: `leadly-portal` (ref `kkdtrkfcnyvuefazndnj`, org "Lexy"). Si retomas desde la terminal, esto es lo que ya existe:

- `leadly-db/supabase/migrations/` — 17 migraciones aplicadas (`supabase db push` desde `leadly-db/`): esquema completo de `tenants`/`profiles`/RLS, catálogo `ai_models`, `whatsapp_lines`/`ai_assistants`/`whatsapp_conversations`/`whatsapp_messages` con RLS y hardening de privilegios, `self_register_tenant` (auto-registro), enforcement de desactivación de tenant (`auth_active_tenant_id()`), Vault para el access token de Meta (escritura: `set_whatsapp_line_access_token`; lectura: `get_whatsapp_line_access_token`), campos extendidos de tenant + bucket `tenant-logos`, `whatsapp_conversations`/`whatsapp_messages` en la publicación `supabase_realtime`, y **`crm_contacts`/`crm_notes`** (ver 3.4) con `whatsapp_conversations.contact_id` y una policy de insert para que un agente pueda iniciar una conversación desde el panel (antes solo el webhook, vía service_role, podía crear conversaciones).
- `leadly-db/supabase/functions/` — 5 Edge Functions desplegadas (`supabase functions deploy <nombre> --use-api`, sin Docker): `self-delete-account`, `admin-create-tenant-user`, `whatsapp-webhook` (público, `--no-verify-jwt` — **ojo:** cada redeploy sin ese flag reactiva la verificación de JWT del gateway y rompe el webhook con 401, pasó una vez en esta sesión), `whatsapp-ai-respond` (interno, solo invocable con el service role key), `whatsapp-send-human` (JWT del propio agente/tenant_admin). `whatsapp-webhook` ahora también auto-crea/vincula un `crm_contacts` por teléfono en cada mensaje entrante (select-then-insert, no upsert, para no pisar el nombre si el tenant ya lo editó). Lógica compartida de Meta en `functions/_shared/whatsapp.ts`.
- `leadly-app/` — corre con `npm run dev` (puerto 5173). Auth completa, backoffice con CRUD de Clientes (tenants) + Líneas de WhatsApp anidadas + Asistente de IA + Usuarios, Changelog estático. Panel del tenant (`/app`) ahora es un **CRM real**, no solo un inbox:
  - **Conversaciones** (`/app`, `pages/tenant/Inbox.tsx`): lista + chat con burbujas (contacto/IA/agente), toggle IA/humano en tiempo real, envío manual, botón **"Nueva conversación"** (elige un cliente existente o crea uno nuevo + línea, `pages/tenant/inbox/NewConversationDrawer.tsx`), mobile-first.
  - **Clientes** (`/app/clientes`, `pages/tenant/Contactos.tsx` + `ContactoDetalle.tsx`): listado de contactos del CRM del tenant (buscador, etapa, etiquetas) con drawer crear/editar (`pages/tenant/contacts/ContactDrawer.tsx`), y detalle con info + **notas manuales** (`crm_notes`) + **historial de conversaciones de WhatsApp vinculadas** (deep-link a `/app?c=<id>` que auto-selecciona la conversación en el Inbox).
  - **Campañas** y **Catálogo** (`/app/campanas`, `/app/catalogo`): visibles en el nav con tag "Beta" y una pantalla bloqueada (`pages/tenant/LockedFeature.tsx`) — sin funcionalidad real a propósito, quedan para una fase futura (pausas publicitarias / catálogo de productos de WhatsApp).
  - **Categoría de conversación**: select en el header del chat (venta/soporte/consulta/reclamo/otro, `whatsapp_conversations.category`), visible como badge en la lista de conversaciones.
  - **Mi cuenta** (`/backoffice/perfil` y `/app/perfil`, `pages/shared/MiCuenta.tsx`, enlazado desde el nombre al pie del sidebar en `AppShell`): cualquier usuario logueado edita su nombre/teléfono y cambia su contraseña. No existía ninguna vista de perfil antes del 2026-08-04.
  - **Configuración de IA** (`/backoffice/configuracion`, superadmin únicamente, `pages/backoffice/Configuracion.tsx`): setea las API keys de OpenAI/Gemini **compartidas por toda la plataforma** (no por tenant, ver 1 "API keys de IA") sin usar la terminal. Antes del 2026-08-04 esas keys solo existían como `Deno.env` secrets de Edge Function (`supabase secrets set`) — ahora viven cifradas en Vault (`platform_ai_keys`, mismo patrón write-only que el token de Meta) y `whatsapp-ai-respond` las lee vía `get_platform_ai_key` (RPC solo para `service_role`) en vez de `Deno.env.get`.
- Sistema de diseño propio en `leadly-app/src/components/ui/` — **pendiente**: rediseño visual (referencia nunca compartida) queda diferido al final, decisión explícita del usuario.
- **Linear**: sigue sin verse como conector en esta sesión. Tracking local únicamente — reconstruir backlog desde este documento si se retoma desde la terminal.
- **Pitfalls descubiertos en esta sesión** (ver también sección 6): (1) Edge Functions matan cualquier `fetch()` fire-and-forget no esperado al retornar la `Response` — usar siempre `await`. (2) `SUPABASE_SERVICE_ROLE_KEY` puede venir en formato JWT clásico o `sb_secret_...` — comparar por string, no decodificar como JWT. (3) Redesplegar `whatsapp-webhook` sin `--no-verify-jwt` explícito en cada `deploy` reactiva la verificación de JWT del gateway (no es "sticky" desde el primer deploy).
- **Falta explícitamente**: Dashboard real (backoffice y cliente, hoy placeholder), Changelog como tabla editable, rediseño visual pendiente, pipeline visual tipo kanban para las etapas de `crm_contacts` (hoy solo texto/badge en la tabla y el detalle), y las dependencias externas del usuario para producción real: keys de OpenAI/Gemini y una línea de WhatsApp Business verificada por Meta (todo probado con payloads simulados firmados y credenciales placeholder — falla con gracia como se espera).

---

## 1. Decisiones de producto (cerradas)

| Tema | Decisión | Notas |
|---|---|---|
| Nombre | **Leadly** | |
| Organización de Supabase | **Lexy** (no la org "Bedly") | El MCP de Supabase de esta sesión solo ve "Bedly" — hay que loguear/conectar el MCP contra la cuenta de la org "Lexy" antes de poder crear el proyecto. Primera tarea bloqueante del roadmap. |
| Proyecto de Supabase | Nuevo y dedicado, no compartido con Bedly ni Lexy-web | |
| Integración de WhatsApp | **Meta Cloud API directo** (mismo patrón que seeri) | `graph.facebook.com`, `phone_number_id`, `business_account_id`, webhook propio con `X-Hub-Signature-256` + `verify_token`. No hay agregador (Twilio/360dialog). Implica que cada tenant debe pasar por verificación de negocio de Meta — se documenta como requisito de onboarding, no como bloqueante técnico. |
| API keys de IA | **Leadly usa keys propias compartidas** (OpenAI y Gemini), igual que el patrón de fallback de seeri (`OPENAI_API_KEY` global) | Costeado por Leadly, facturado al tenant por plan (límite de mensajes/tokens). Se deja la puerta abierta a que un tenant traiga su propia key en el futuro (columna nullable, no v1). |
| Proveedor de IA | **Multi-proveedor desde el día 1**: OpenAI (ChatGPT) o Google (Gemini), seleccionable por asistente | Ver sección 3.3 — esto descarta usar el objeto "Assistant" del dashboard de OpenAI como fuente de verdad (Gemini no tiene equivalente), así que la config vive en nuestra propia tabla y las llamadas a los LLM son *stateless* (chat/responses por turno), no threads persistentes del lado del proveedor. |
| Auth | Email/password + Google OAuth (Supabase Auth), **registro libre abierto** | `disable_signup` se deja en `false` a propósito (decisión revertida el 2026-08-02: se evaluó cerrarlo y se decidió lo contrario). Cualquiera puede crear una cuenta; lo que la separa de "tener acceso" es la fila en `profiles` (ver siguiente fila). |
| Multi-tenancy | Dos caminos para crear un tenant, ambos terminan en la misma tabla `tenants`+`profiles`: (1) el superadmin lo crea desde el backoffice y asigna línea de WhatsApp, o (2) **auto-registro**: un usuario nuevo (Google o email/password) sin fila en `profiles` aterriza en la pantalla de onboarding `/create-company`, y al enviar el nombre de su empresa se crea el tenant y queda como su `tenant_admin` vía la función `self_register_tenant` (RPC `SECURITY DEFINER`, `leadly-db/supabase/migrations/20260802000008_self_register_tenant.sql`). Si fue sin querer, puede borrar su cuenta ahí mismo (`self-delete-account`, Edge Function) — solo funciona si esa cuenta *todavía* no tiene perfil, nunca sobre un tenant ya activo. | La app (`AuthContext.unprovisioned` + `RequireAuth`) es la que decide mostrar `/create-company` en vez de contenido real cuando `auth.uid()` no tiene fila en `profiles`. Un tenant auto-registrado queda con el mismo `status='active'` que uno creado por el backoffice — sin distinción por diseño (decisión del usuario). No pueden usar WhatsApp real hasta que el superadmin les asigne una línea manualmente. |

### Spikes que quedan abiertos (no bloquean el MVP, se resuelven en Fase 2+)

- Alcance de "herramientas"/function-calling por tenant (genérico configurable vs. predefinido por vertical). **No entra en el MVP** — el MVP es conversación + system prompt + traspaso a humano, sin acciones automatizadas.
- Modelo de facturación/planes de Leadly a sus tenants (límites de mensajes/tokens). Se diseña en Fase 3.
- Cifrado en reposo de credenciales (Meta token, API keys) — Supabase Vault/`pgsodium`. Se resuelve como parte de Fase 0 (no se puede posponer, son secretos reales).

---

## 2. Estructura del repositorio

Dos carpetas hermanas dentro de `Desktop/Proyectos/Leadly/`, mismo patrón que Bedly:

```
Leadly/
├── CLAUDE.md          ← este archivo
├── plan.md            ← historial de la sesión de origen (no editar, solo referencia)
├── leadly-app/        ← frontend: React 19 + TypeScript + Vite + Tailwind v4
└── leadly-db/         ← Supabase: migraciones SQL, seeds, config de Edge Functions
```

- `leadly-app/`: SPA única con dos layouts protegidos por rol (sección 4). Incluye `CHANGELOG.md` propio (sección 7).
- `leadly-db/`: `supabase/migrations/*.sql`, `supabase/functions/*` (Edge Functions), `supabase/seed.sql`. Sin backend propio — Postgres + RLS + Auth + Storage + Edge Functions cubren todo.

---

## 3. Modelo de datos (núcleo, v1)

### 3.1 Multi-tenancy y roles
- `tenants` — un negocio cliente de Leadly. Más allá de `name`/`status`, incluye datos reales de identidad legal y contacto (agregados en `20260802000013_tenant_profile_fields.sql` a pedido explícito del usuario, "el formulario de crear empresa es muy corto"): `entity_type` (`persona`|`empresa`), `legal_name` (obligatorio en el formulario si es empresa), `document_type`/`document_number`, `contact_email`/`contact_phone` (obligatorios en el formulario), `country`/`state_province`, `preferred_language` (`es`|`en` — primer paso hacia multi-idioma), `logo_url` (bucket Storage `tenant-logos`, público de lectura, máx. 5MB, RLS de escritura por tenant/superadmin). Estos campos son NULLables a nivel de base de datos (para no romper `self_register_tenant`, que solo pide el nombre) — lo "obligatorio" vive en la validación del formulario (`leadly-app/src/pages/backoffice/useTenantForm.ts`), no en constraints de DB.
- `profiles` — `id` (= `auth.users.id`), `role` (`superadmin` | `tenant_admin` | `tenant_agent`), `tenant_id` (null para superadmin).
- `auth_tenant_id()` / `is_superadmin()` — funciones `SECURITY DEFINER`, mismo patrón que Bedly (`bedly-db/supabase/migrations/20260729000002_helpers.sql` como referencia directa a copiar/adaptar).
- RLS en toda tabla con `tenant_id`: el tenant solo ve sus propias filas; el superadmin ve todo.

### 3.2 WhatsApp
- `whatsapp_lines` — una fila por número de WhatsApp Business asignado a un tenant: `tenant_id`, `phone_number_id`, `business_account_id`, `access_token` (cifrado), `display_name`, `status` (`pending_verification` | `active` | `suspended`).
- `whatsapp_conversations` — `tenant_id`, `whatsapp_line_id`, `contact_phone`, `contact_name` nullable, `mode` (`ia` | `humano`), `status` (`open` | `closed`), `last_message_at`.
- `whatsapp_messages` — ledger inmutable (append-only): `conversation_id`, `direction` (`inbound` | `outbound`), `sender` (`contact` | `ia` | `agent:<profile_id>`), `content`, `wamid`, `tokens_used` nullable, `error_message` nullable, `created_at`.

### 3.3 Configuración de IA (multi-proveedor)
- `ai_assistants` — uno por `whatsapp_line_id` (o uno por tenant si un tenant puede tener varias líneas compartiendo config, a confirmar en diseño detallado):
  - `provider` (`openai` | `gemini`)
  - `model` (string libre validado contra una lista permitida por proveedor, ej. `gpt-4.1`, `gpt-4o-mini`, `gemini-2.5-pro`, `gemini-2.5-flash`)
  - `system_prompt` (text)
  - `temperature`, `max_tokens` (opcional, valores por defecto razonables)
  - `is_active` (boolean — permite desactivar la IA sin borrar la config)
- La UI del backoffice/cliente para editar esto es un **select de proveedor + select de modelo dependiente** (el segundo select se filtra según el proveedor elegido), no campos de texto libre — requisito explícito del usuario.
- Las llamadas a IA son *stateless por turno*: se arma el contexto (system prompt + últimos N mensajes de `whatsapp_messages`) y se envía a la API del proveedor correspondiente (Chat Completions/Responses de OpenAI, `generateContent` de Gemini) vía Edge Function. No se depende del objeto "Assistant" ni "Thread" del dashboard de OpenAI.

### 3.4 CRM del tenant (contactos)
Agregado el 2026-08-03 a pedido explícito del usuario ("no quiero nada a medias, piensa en un CRM completo") — un `whatsapp_conversations.contact_phone` suelto no bastaba, cada tenant necesita una ficha de cliente persistente con historial, no conversaciones desechables.

- `crm_contacts` — el lead/cliente **del tenant** (no confundir con `tenants`, que son los clientes de Leadly): `tenant_id`, `full_name`, `phone` (único por tenant), `email`/`company` nullable, `stage` (`lead`|`contactado`|`negociacion`|`cliente`|`perdido`), `tags` (`text[]`), `assigned_to` (nullable, `profiles.id`).
- `crm_notes` — bitácora manual append-only sobre un contacto: `contact_id`, `author_id`, `content`, `created_at`. Sin políticas de update/delete a propósito, igual que `whatsapp_messages`.
- `whatsapp_conversations.contact_id` — FK nullable a `crm_contacts`. `whatsapp-webhook` lo resuelve automáticamente en cada mensaje entrante (busca por `tenant_id`+`phone`, crea el contacto si no existe) — así toda conversación real queda ligada a una ficha de cliente sin que el tenant tenga que hacer nada manual.
- El detalle de un contacto (`/app/clientes/:id`) es donde vive "todo lo que se ha hablado con él": notas manuales + la lista de conversaciones de WhatsApp vinculadas (con link directo al Inbox).
- Pendiente/spike abierto: vista de pipeline tipo kanban por `stage` (hoy es solo un badge en tabla/detalle, sin drag-and-drop ni tablero visual).

---

## 4. Layouts y navegación (guard por rol)

Dos layouts, cada uno con su propio árbol de rutas, protegidos tanto por **guard de navegación** (redirección si el rol no corresponde) como por **RLS en la base de datos** (defensa en profundidad — nunca confiar solo en el guard de frontend):

### 4.1 `BackofficeLayout` (rol `superadmin`)
- Dashboard: resumen de tenants activos, líneas de WhatsApp, conversaciones del día.
- **Clientes (tenants)**: CRUD — crear, ver detalle, activar/desactivar, ver plan.
- **Líneas de WhatsApp**: CRUD, asignación a un tenant, estado de verificación de Meta.
- **Configuración de IA por línea**: system prompt (editor de texto largo) + selects de proveedor/modelo + parámetros opcionales, con vista previa/chat de prueba antes de guardar.
- **Usuarios por tenant**: crear usuarios (`tenant_admin`/`tenant_agent`) vía Edge Function `admin-create-tenant-user`.
- **Changelog** (sección 7): ver el historial de versiones publicado, visible también para tenants.

### 4.2 `TenantLayout` (roles `tenant_admin` / `tenant_agent`)
- Dashboard simple: conversaciones abiertas, mensajes sin responder (aún placeholder).
- **Conversaciones** (Inbox): lista + vista de chat estilo WhatsApp Web (burbujas, orden cronológico).
  - Toggle **modo IA / modo humano** por conversación — al pasar a humano, la IA deja de responder automáticamente y el agente escribe directo.
  - Historial completo de mensajes, incluyendo los que respondió la IA (marcados visualmente distinto a los del agente humano).
  - **Nueva conversación**: el agente puede iniciar una conversación él mismo (elige un cliente del CRM o crea uno nuevo + línea), no solo reaccionar a mensajes entrantes.
- **Clientes** (CRM, ver 3.4): listado de contactos con buscador/etapa/etiquetas, ficha de detalle con info + notas manuales + historial de conversaciones vinculadas.
- **Campañas** / **Catálogo**: visibles en el nav con tag "Beta", pantalla bloqueada sin funcionalidad — reservado para pausas publicitarias y catálogo de productos, no es parte del alcance actual.
- **Configuración de IA de su(s) línea(s)**: mismo componente de selects proveedor/modelo + system prompt que en backoffice, pero acotado a su propio tenant (RLS).
- **Changelog**: versión de solo lectura, mismo componente que en backoffice.

### 4.3 Guards
- Guard de ruta (`RequireAuth` + `RequireRole`) que redirige según `profiles.role` — mismo patrón que Bedly.
- La navegación (sidebar/menú) se arma condicionalmente según el rol; nunca se renderiza un link a una ruta que el guard vaya a bloquear.

---

## 5. Diseño / UX

- Diseño simple, moderno, **mobile-first** — el panel de cliente debe usarse cómodamente desde el teléfono (revisar conversaciones y responder en modo humano es el caso de uso más probable en movilidad).
- Paleta e identidad: usar los assets de marca ya definidos (azul principal `#101A35`, turquesa `#2FA9A5`, tipografía Manrope/Inter) — ver brandbook compartido.
- Componentes reutilizables entre ambos layouts donde aplique (selects, tablas, chat), variando solo el scope de datos por rol.

---

## 6. Edge Functions (v1)

Todas desplegadas y probadas end-to-end (webhook simulado con payload de Meta firmado + curl directo). Sin keys reales de OpenAI/Gemini ni línea verificada por Meta todavía, así que las llamadas externas fallan con gracia (mensaje de fallback al contacto + `error_message` en `whatsapp_messages`) — comportamiento esperado hasta que el usuario aporte esas credenciales.

- `whatsapp-webhook` — ✅ handshake `GET` + mensajes entrantes `POST`, valida firma (`X-Hub-Signature-256`) y `verify_token`, resuelve/crea conversación (`upsert` por `whatsapp_line_id`+`contact_phone`), inserta mensaje inbound, e invoca `whatsapp-ai-respond` (con `await`, ver pitfall en "Estado actual") cuando la conversación está en modo IA y la línea activa. Desplegada con `--no-verify-jwt` (endpoint público, Meta no manda JWT).
- `whatsapp-ai-respond` — ✅ interno, solo acepta llamadas cuyo bearer token sea exactamente el `SUPABASE_SERVICE_ROLE_KEY` del proyecto. Arma contexto (últimos 10 mensajes), detecta traspaso a humano por frase antes de llamar al LLM, llama al proveedor configurado (`ai_assistants.provider`), responde por Graph API. No se ejecuta si la conversación está en modo humano, la línea no está activa, o el asistente está inactivo. **Cumplimiento Meta implementado** (política AI-Assisted Business Messaging Guidelines, vigente desde 2026-01-15): divulga que es IA en el primer mensaje automático de cada conversación (`alreadyRespondedByAi` chequea el historial), y frases tipo "hablar con humano" cambian `mode` a `humano` automáticamente (`_shared/whatsapp.ts::requestsHumanHandoff`). Pendiente/spike abierto: validación/aviso en el editor de `system_prompt` para que un tenant no lo configure como asistente genérico sin límite de tema.
- `whatsapp-send-human` — ✅ envío de mensaje manual desde el panel del tenant en modo humano; usa el JWT del propio caller (no admin), así que RLS aplica tal cual sin lógica de autorización reinventada.
- `admin-create-tenant-user` — ✅ creación de usuarios de un tenant (mismo patrón que `admin-create-user` de Bedly), invita por correo (`inviteUserByEmail`).

---

## 7. Changelog del producto

- `leadly-app/CHANGELOG.md`, formato [Keep a Changelog](https://keepachangelog.com/) + versionado semántico, empezando en `0.1.0` para el MVP.
- Se expone también dentro de la app (sección "Novedades" visible en ambos layouts) leyendo el mismo archivo o una tabla `release_notes` si se prefiere editable desde el backoffice sin deploy — **decidir en Fase 1**: archivo estático vs. tabla editable.

---

## 8. Roadmap por fases (MVP = Fases 0-2)

### Fase 0 — Fundación ✅ completa
- [x] Proyecto Supabase `leadly-portal` en la org "Lexy".
- [x] Scaffold `leadly-app/` (Vite+React+TS+Tailwind) y `leadly-db/` (migraciones).
- [x] Esquema: `tenants`, `profiles`, `auth_tenant_id()`/`is_superadmin()`, RLS base.
- [x] Auth: email/password + Google OAuth + registro libre + onboarding de auto-registro.
- [x] `BackofficeLayout` + `TenantLayout` con guards de ruta, sidebar colapsable y navegación condicional por rol.

### Fase 1 — Backoffice del superadmin (mayormente completa)
- [x] CRUD de tenants (formulario completo, ver 3.1).
- [x] CRUD de líneas de WhatsApp + asignación a tenant — vive **dentro** del detalle de cada Cliente, no como sección aparte del menú (decisión del usuario).
- [x] Cifrado del access token de Meta (Supabase Vault).
- [x] Configuración de IA (selects proveedor/modelo dependientes + system prompt) por línea, en backoffice y en panel del cliente (`/app/asistente`).
- [x] Creación de usuarios por tenant (`admin-create-tenant-user`, invita por correo con `inviteUserByEmail` — nunca se maneja una contraseña directamente) — pantalla "Usuarios" tanto en backoffice (dentro de cada Cliente) como en panel del cliente (`tenant_admin` únicamente).
- [x] Changelog visible en la app (archivo estático `CHANGELOG.md`, no tabla editable todavía).
- [ ] Dashboard real (backoffice y cliente) — sigue siendo placeholder.

### Fase 2 — Panel del cliente + conversación en vivo + CRM ✅ completa (pendiente de credenciales reales del usuario para probar en producción)
- [x] Webhook de WhatsApp (`whatsapp-webhook`) + recepción de mensajes — probado con payloads de Meta simulados y firmados.
- [x] Edge function de respuesta con IA multi-proveedor (`whatsapp-ai-respond`) + envío manual (`whatsapp-send-human`) — probados end-to-end; fallan con gracia sin `OPENAI_API_KEY`/`GEMINI_API_KEY` reales ni token de Meta real, como se esperaba.
- [x] Inbox de conversaciones del tenant (`/app`, `leadly-app/src/pages/tenant/Inbox.tsx` + `pages/tenant/inbox/`) + toggle IA/humano en tiempo real (Supabase Realtime) + envío manual + "Nueva conversación", mobile-first.
- [x] CRM de contactos (`crm_contacts`/`crm_notes`, ver 3.4): listado + detalle con notas e historial de conversaciones, auto-creación de contacto desde el webhook. Agregado el 2026-08-03, un día antes de una demo del usuario — "no quiero nada a medias, piensa en un CRM completo" (se investigó qué ofrecen Kommo/Rasayel/Chatwoot para no dejar cosas básicas fuera: contacto único con historial completo, etapas tipo pipeline, notas, inbox unificado — todo cubierto salvo el tablero kanban visual).
- [x] Campañas y Catálogo visibles en el nav como "Beta" bloqueado (`pages/tenant/LockedFeature.tsx`) — a propósito sin funcionalidad, para que la demo no se sienta con huecos en el menú sin prometer algo que no existe.
- **Fin del MVP** funcionalmente completo — falta solo que el usuario aporte keys de IA reales y una línea de WhatsApp verificada por Meta para probar con tráfico real. A partir de aquí, priorizar con el usuario según feedback real de los primeros tenants.

### Fase 3+ (post-MVP, no detallado en Linear todavía)
- Campañas (pausas publicitarias / envíos masivos) y Catálogo de WhatsApp — hoy solo bloqueados con tag "Beta" en el nav del tenant, sin ningún backend.
- Pipeline visual (kanban) para las etapas de `crm_contacts`.
- Planes y facturación (`plans`/`subscriptions`).
- Function-calling / herramientas por tenant.
- Cumplimiento (ventana 24h de WhatsApp, plantillas, habeas data).
- Infraestructura de despliegue (hosting, dominio, CI, monitoreo, backups).

---

## 9. Cómo se trackea el trabajo

**Linear es la fuente de verdad del backlog** (evita reprocesos si se usa otra IA o si el usuario avanza manualmente). Este `CLAUDE.md` explica arquitectura y decisiones; Linear lleva el estado de cada tarea. Antes de empezar a implementar cualquier tarea, revisar su estado en Linear — si ya está "In Progress" o "Done" fuera de esta sesión, no reprocesar sin confirmar con el usuario.
