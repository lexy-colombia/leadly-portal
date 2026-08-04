# Leadly — Backlog draft para Linear (MVP: Fases 0-2)

> Borrador para aprobación. Nada de esto se ha creado en Linear todavía. Estructura pensada para Linear: 1 **Project** ("Leadly MVP"), issues tipados como **Epic** (usamos label `epic` + issue padre, ya que Linear no tiene un tipo nativo "Epic" fuera de sus propios "Projects/Milestones" — alternativa: cada Epic = un **Milestone** dentro del Project "Leadly MVP", y cada Story/Task es un issue asociado a ese milestone. Confirmar cuál de las dos convenciones prefieres antes de crear).
>
> Campos por issue: **Título, Tipo, Descripción, Criterios de aceptación, Labels, Prioridad, Estimación (puntos), Depende de**.
> Labels propuestos: `fundacion` `backoffice` `cliente` `supabase` `whatsapp` `ia` `auth` `infra` `diseño` `spike`
> Prioridad: Urgent / High / Medium / Low (escala de Linear)
> Estimación: Fibonacci 1-2-3-5-8

---

## Milestone / Epic 0 — Fundación (Supabase + Auth + Multi-tenancy)

### LEAD-1 · Spike: conectar MCP/CLI de Supabase a la organización "Lexy"
- **Tipo**: Spike · **Prioridad**: Urgent · **Estimación**: 1 · **Labels**: `fundacion` `supabase` `spike`
- **Descripción**: El MCP de Supabase usado hasta ahora solo ve la organización "Bedly". Hay que autenticar el acceso (login/token) contra la cuenta que tiene la organización "Lexy" antes de poder crear el proyecto de Leadly.
- **Criterios de aceptación**:
  - [ ] Se puede listar la organización "Lexy" desde el MCP/CLI de Supabase.
  - [ ] Confirmado con el usuario que es la cuenta correcta para facturar/administrar Leadly.
- **Depende de**: —

### LEAD-2 · Crear proyecto de Supabase dedicado para Leadly
- **Tipo**: Task · **Prioridad**: Urgent · **Estimación**: 1 · **Labels**: `fundacion` `supabase`
- **Descripción**: Proyecto nuevo dentro de la org "Lexy", región más cercana a los tenants (a definir), sin compartir DB/Auth con Bedly ni lexy-web.
- **Criterios de aceptación**:
  - [ ] Proyecto creado y en estado `ACTIVE_HEALTHY`.
  - [ ] Credenciales (`SUPABASE_URL`, `anon key`, `service_role key`) guardadas en `.env.example` (sin valores reales) y comunicadas al usuario de forma segura.
- **Depende de**: LEAD-1

### LEAD-3 · Scaffold `leadly-app/` (Vite + React 19 + TS + Tailwind v4)
- **Tipo**: Task · **Prioridad**: High · **Estimación**: 2 · **Labels**: `fundacion`
- **Descripción**: Mismo stack y estructura base que `bedly-app`, incluyendo cliente de Supabase, router, estructura de carpetas (`layouts/`, `pages/`, `components/`, `hooks/`, `lib/`).
- **Criterios de aceptación**:
  - [ ] `npm run dev` levanta la app sin errores.
  - [ ] Cliente de Supabase configurado con variables de entorno.
  - [ ] Estructura de carpetas documentada en un README corto dentro de `leadly-app/`.
- **Depende de**: LEAD-2

### LEAD-4 · Scaffold `leadly-db/` y primera migración (`tenants`, `profiles`)
- **Tipo**: Task · **Prioridad**: High · **Estimación**: 2 · **Labels**: `fundacion` `supabase`
- **Descripción**: Estructura `supabase/migrations/`, `supabase/seed.sql`. Migración inicial con tablas `tenants` y `profiles` (campos: ver sección 3.1 de CLAUDE.md).
- **Criterios de aceptación**:
  - [ ] Migración aplica limpio en el proyecto nuevo.
  - [ ] `profiles.role` restringido por `CHECK` a (`superadmin`, `tenant_admin`, `tenant_agent`).
  - [ ] Seed con un usuario `superadmin` de prueba.
- **Depende de**: LEAD-2

### LEAD-5 · Funciones RLS `auth_tenant_id()` / `is_superadmin()` + políticas base
- **Tipo**: Task · **Prioridad**: High · **Estimación**: 3 · **Labels**: `fundacion` `supabase`
- **Descripción**: Adaptar el patrón exacto de `bedly-db/supabase/migrations/20260729000002_helpers.sql`. RLS habilitado en `tenants` y `profiles` desde el día 1.
- **Criterios de aceptación**:
  - [ ] Un usuario tenant no puede leer/editar filas de otro tenant (probado con al menos 2 tenants de prueba).
  - [ ] Un superadmin puede leer/editar todo.
  - [ ] Tests manuales documentados (queries de prueba con distintos JWT).
- **Depende de**: LEAD-4

### LEAD-6 · Auth: email/password + Google OAuth
- **Tipo**: Task · **Prioridad**: High · **Estimación**: 3 · **Labels**: `fundacion` `auth`
- **Descripción**: Pantallas de login/registro, `signInWithOAuth('google')`, manejo de sesión y redirect post-login según rol.
- **Criterios de aceptación**:
  - [ ] Login con email/password funcional.
  - [ ] Login con Google funcional en dev y con dominio de producción configurado en Supabase Auth.
  - [ ] Al loguearse, se redirige a `/backoffice` o `/app` según `profiles.role`.
- **Depende de**: LEAD-3, LEAD-5

### LEAD-7 · Layouts base + guards de ruta por rol
- **Tipo**: Task · **Prioridad**: High · **Estimación**: 3 · **Labels**: `fundacion` `backoffice` `cliente`
- **Descripción**: `BackofficeLayout` y `TenantLayout` (shells con sidebar/nav), componentes `RequireAuth`/`RequireRole`, navegación condicional según rol (nunca mostrar un link a una ruta bloqueada).
- **Criterios de aceptación**:
  - [ ] Un `tenant_admin` que intenta entrar a `/backoffice/*` es redirigido, no ve error en blanco.
  - [ ] Un `superadmin` sin tenant no ve rutas de `TenantLayout` en su navegación.
  - [ ] Responsive: ambos layouts usables en viewport móvil (probado en 375px de ancho).
- **Depende de**: LEAD-6

### LEAD-8 · Sistema de diseño base (tokens, tipografía, componentes compartidos)
- **Tipo**: Task · **Prioridad**: Medium · **Estimación**: 2 · **Labels**: `fundacion` `diseño`
- **Descripción**: Tailwind config con paleta de marca (`#101A35`, `#2FA9A5`, gris claro, blanco), tipografía Manrope/Inter, componentes base reutilizables (botón, input, select, tabla, card) usados por ambos layouts.
- **Criterios de aceptación**:
  - [ ] Componentes documentados/visibles en una página de prueba (`/dev/ui-kit` o similar, solo en dev).
  - [ ] Contraste de color validado (WCAG AA mínimo) sobre fondo claro y oscuro.
- **Depende de**: LEAD-3

### LEAD-9 · Cifrado de credenciales sensibles (Meta token, API keys de IA)
- **Tipo**: Spike/Task · **Prioridad**: High · **Estimación**: 3 · **Labels**: `fundacion` `infra` `spike`
- **Descripción**: Definir mecanismo (Supabase Vault / `pgsodium` / cifrado a nivel de Edge Function con una clave en secrets) para no guardar `access_token` de Meta ni API keys en texto plano.
- **Criterios de aceptación**:
  - [ ] Decisión documentada en CLAUDE.md con justificación.
  - [ ] Migración/función de cifrado-descifrado implementada y probada.
- **Depende de**: LEAD-4

---

## Milestone / Epic 1 — Backoffice del superadmin

### LEAD-10 · CRUD de tenants
- **Tipo**: Story · **Prioridad**: High · **Estimación**: 3 · **Labels**: `backoffice`
- **Descripción**: Listado con búsqueda/filtro por estado, formulario de creación (nombre, plan, estado), vista de detalle, activar/desactivar.
- **Criterios de aceptación**:
  - [ ] Crear tenant crea también su `profiles` de `tenant_admin` inicial (o dispara flujo de LEAD-14).
  - [ ] Desactivar un tenant bloquea el login de sus usuarios (verificado).
  - [ ] Formulario valida campos requeridos con mensajes claros.
- **Depende de**: LEAD-7

### LEAD-11 · CRUD de líneas de WhatsApp + asignación a tenant
- **Tipo**: Story · **Prioridad**: High · **Estimación**: 5 · **Labels**: `backoffice` `whatsapp`
- **Descripción**: Alta de línea (`phone_number_id`, `business_account_id`, `access_token`), asignación a un tenant existente, estado de verificación.
- **Criterios de aceptación**:
  - [ ] No se puede asignar la misma línea a dos tenants.
  - [ ] El `access_token` nunca se muestra en texto plano después de guardado (solo enmascarado, patrón `***masked***` como en seeri).
  - [ ] Estado de la línea visible (`pending_verification` / `active` / `suspended`).
- **Depende de**: LEAD-10, LEAD-9

### LEAD-12 · Configuración de IA por línea (selects proveedor/modelo + system prompt)
- **Tipo**: Story · **Prioridad**: High · **Estimación**: 5 · **Labels**: `backoffice` `ia`
- **Descripción**: Formulario con select de proveedor (OpenAI/Gemini) que filtra un segundo select de modelos válidos para ese proveedor, editor de `system_prompt`, parámetros opcionales (`temperature`, `max_tokens`), toggle `is_active`.
- **Criterios de aceptación**:
  - [ ] Cambiar de proveedor resetea/filtra el select de modelo (no permite combinaciones inválidas, ej. modelo de Gemini con proveedor OpenAI).
  - [ ] Guardar es instantáneo (sin necesidad de redeploy) y queda auditado (quién y cuándo cambió el prompt — `updated_by`, `updated_at`).
  - [ ] Botón de "probar" que envía un mensaje de prueba al modelo configurado y muestra la respuesta antes de confirmar cambios en producción (puede ser Fase 1 tardía si el tiempo aprieta — marcar como *nice to have* si se necesita cortar alcance).
- **Depende de**: LEAD-11

### LEAD-13 · Creación de usuarios por tenant (Edge Function `admin-create-tenant-user`)
- **Tipo**: Story · **Prioridad**: Medium · **Estimación**: 3 · **Labels**: `backoffice` `auth`
- **Descripción**: El superadmin (o un `tenant_admin` para su propio tenant) crea usuarios `tenant_admin`/`tenant_agent`, envío de invitación por email.
- **Criterios de aceptación**:
  - [ ] Un `tenant_admin` solo puede crear usuarios para su propio `tenant_id` (validado también server-side en la Edge Function, no solo en UI).
  - [ ] El usuario invitado recibe email y puede establecer contraseña o loguearse con Google.
- **Depende de**: LEAD-10

### LEAD-14 · Changelog visible en la app
- **Tipo**: Task · **Prioridad**: Low · **Estimación**: 2 · **Labels**: `backoffice` `cliente` `diseño`
- **Descripción**: Sección "Novedades" visible en ambos layouts, alimentada por `leadly-app/CHANGELOG.md` (v1: archivo estático parseado en build; evaluar tabla `release_notes` editable si se necesita publicar sin deploy).
- **Criterios de aceptación**:
  - [ ] `CHANGELOG.md` sigue formato Keep a Changelog, empieza en `0.1.0`.
  - [ ] Se ve correctamente en móvil y desktop.
- **Depende de**: LEAD-7

---

## Milestone / Epic 2 — Panel del cliente + conversación en vivo (cierre del MVP)

### LEAD-15 · Edge Function `whatsapp-webhook` (recepción de mensajes)
- **Tipo**: Story · **Prioridad**: Urgent · **Estimación**: 5 · **Labels**: `cliente` `whatsapp`
- **Descripción**: Handshake `GET` (verify_token) + `POST` de mensajes entrantes, validación de firma `X-Hub-Signature-256`, resolución/creación de `whatsapp_conversations`, inserción en `whatsapp_messages`.
- **Criterios de aceptación**:
  - [ ] Webhook responde correctamente al challenge de verificación de Meta.
  - [ ] Firma inválida es rechazada (401/403), no se procesa el payload.
  - [ ] Mensaje de un contacto nuevo crea conversación nueva; de un contacto existente, la reutiliza.
- **Depende de**: LEAD-11, LEAD-9

### LEAD-16 · Edge Function `whatsapp-ai-respond`
- **Tipo**: Story · **Prioridad**: Urgent · **Estimación**: 5 · **Labels**: `cliente` `whatsapp` `ia`
- **Descripción**: Arma contexto (system prompt + últimos N mensajes), llama al proveedor configurado (`ai_assistants.provider`), envía la respuesta por Graph API. No se ejecuta si `whatsapp_conversations.mode = 'humano'`.
- **Criterios de aceptación**:
  - [ ] Funciona con proveedor `openai` y con `gemini` (probado con ambos).
  - [ ] Si la conversación está en modo humano, la función no responde automáticamente.
  - [ ] Errores del proveedor (rate limit, key inválida) se guardan en `whatsapp_messages.error_message`, no rompen el webhook.
- **Depende de**: LEAD-15, LEAD-12

### LEAD-17 · Inbox de conversaciones (panel del tenant)
- **Tipo**: Story · **Prioridad**: High · **Estimación**: 5 · **Labels**: `cliente` `whatsapp` `diseño`
- **Descripción**: Lista de conversaciones (ordenada por `last_message_at`), vista de chat estilo WhatsApp Web, mensajes de IA visualmente distintos de los de agente humano.
- **Criterios de aceptación**:
  - [ ] Usable y legible en móvil (viewport 375px), no solo desktop.
  - [ ] Actualización en tiempo real o polling corto al llegar mensaje nuevo (definir mecanismo: Supabase Realtime recomendado).
  - [ ] Un `tenant_agent`/`tenant_admin` solo ve conversaciones de su propio tenant (RLS, no solo filtro de UI).
- **Depende de**: LEAD-15, LEAD-7

### LEAD-18 · Toggle modo IA / humano + envío manual de mensajes
- **Tipo**: Story · **Prioridad**: High · **Estimación**: 3 · **Labels**: `cliente` `whatsapp`
- **Descripción**: Botón para pasar una conversación a modo humano (detiene respuestas automáticas), campo de texto para responder manualmente vía Edge Function `whatsapp-send-human`.
- **Criterios de aceptación**:
  - [ ] Al pasar a modo humano, `whatsapp-ai-respond` deja de disparar para esa conversación (verificado con LEAD-16).
  - [ ] Mensaje enviado manualmente queda registrado en `whatsapp_messages` con `sender = 'agent:<profile_id>'`.
  - [ ] Se puede volver a modo IA desde la misma conversación.
- **Depende de**: LEAD-17, LEAD-16

---

## Backlog post-MVP (no detallado issue por issue todavía — crear como Milestones vacíos o notas del Project)

- **Epic 3 — Planes y facturación**: `plans`/`subscriptions`, límites de mensajes/tokens por plan, backoffice de facturación.
- **Epic 4 — Function-calling / herramientas por tenant**: genérico configurable vs. predefinido por vertical (spike de diseño primero).
- **Epic 5 — Cumplimiento**: ventana de 24h de WhatsApp, plantillas pre-aprobadas, habeas data/consentimiento.
- **Epic 6 — Infraestructura de despliegue**: hosting, dominio, CI, monitoreo de errores, backups.

---

## Preguntas para ti antes de enviar a Linear

1. ¿Prefieres la convención **Epic = Milestone de Linear** (como está redactado arriba) o **Epic = issue padre con sub-issues**? Cambia cómo se crea todo pero no el contenido.
2. ¿Ya tienes un **team/workspace de Linear** específico para Leadly, o lo creamos nuevo? Necesito ese dato (o conectar el conector de Linear a esta sesión — no está conectado ahora mismo) antes de poder crear los issues.
3. ¿Los IDs `LEAD-1`, `LEAD-2`... están bien como prefijo, o prefieres otro (ej. `LDY`)?
4. ¿Alguna historia te parece que sobra, falta, o tiene el alcance mal cortado para un MVP (por ejemplo, el botón de "probar" en LEAD-12 lo marqué como recortable si hace falta)?
