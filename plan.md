# Leadly — Plataforma multi-tenant de asesores virtuales de WhatsApp con IA

**Estado: solo planeación. No se ha creado ningún proyecto de Supabase ni código todavía.** Este archivo es el punto de partida para continuar en otra sesión de Claude Code.

---

## 0. Contexto y decisión de producto

Este proyecto **nació dentro de una sesión de trabajo sobre Bedly** (sistema de gestión hotelera, cliente Lexy Colombia SAS, repo hermano en `Desktop/Proyectos/Bedly/`). El cliente pidió originalmente "que cada hotel pueda conectar su WhatsApp Business con un asesor de IA que tome reservas" — pero al plantear el alcance completo, el cliente decidió que **esto no es una feature de Bedly, es un producto nuevo e independiente**: una plataforma multi-tenant donde:

- **Leadly (el negocio) tiene un superusuario** que registra nuevos clientes (empresas/negocios de cualquier vertical, no solo hoteles), les asigna líneas de WhatsApp, y administra la plataforma.
- **Cada cliente (tenant) inicia sesión** y ve un layout completamente distinto al del superusuario — su propio panel para configurar su asesor de IA, ver conversaciones, etc.
- **Auth propio de Leadly**, con soporte para social login (Google confirmado, otros proveedores de Supabase Auth quedan abiertos a futuro) además de email/password.
- **Debe tener su propio proyecto de Supabase**, separado del de Bedly — son productos de negocio distintos, no deben compartir base de datos, auth, ni facturación.

### Investigación previa (reutilizable, ya hecha)

Antes de este pivote, se investigó a fondo el proyecto de referencia `Desktop/seeri` (repos `agents`, `conversations`, `threads`, `tania-functions` — plataforma B2B de asesores de WhatsApp con IA de otro negocio del mismo perfil, "Tania"). Hallazgos clave (el detalle completo del análisis está en el historial de la sesión de Bedly, pero el resumen accionable es):

- **`agents`** (Go/Gin/GORM): guarda config de IA por tenant en su propia tabla y llama a la API stateless `/v1/responses` de OpenAI — **no crea objetos visibles en el dashboard de OpenAI**. Si Leadly quiere agentes visibles/editables desde el panel de OpenAI (requisito explícito del cliente), este patrón no sirve tal cual.
- **`conversations`** (Java/Spring/Kafka/Redis): el corazón del patrón real — tabla `assistant` (config IA + credenciales de WhatsApp por línea), `conversation` (`provider_conversation_id` = thread id de OpenAI), `message` (ledger inmutable con `wamid`, tokens, errores), `run` (una fila por ejecución de IA). WhatsApp es **Meta Cloud API directo** (no Twilio/360dialog), con webhook propio y manejo manual de la ventana de 24h de WhatsApp.
- **`threads`**: pese al nombre, es un sistema de colas/enrutamiento a agentes **humanos** (staffing, reglas de asignación, WebSocket) — no tiene nada que ver con OpenAI. Sobredimensionado para un v1.
- **`tania-functions`**: el "MCP server" de function-calling — cada acción que la IA puede ejecutar vive ahí como una herramienta invocable.

**Decisión de arquitectura para Leadly**: no replicar la arquitectura de microservicios de seeri (Go+Java+Kafka+Redis, equipo grande). Leadly parte con el mismo enfoque simple que ya funciona en Bedly: **Supabase (Postgres + RLS + Auth + Storage) + Edge Functions**, sin backend propio, sin colas al menos en v1.

---

## 1. Decisiones ya tomadas en la sesión de origen

| Tema | Decisión |
|---|---|
| Nombre del producto | **Leadly** |
| Ubicación del proyecto | `Desktop/Proyectos/Leadly/` (carpeta hermana de `Bedly/`, ya creada — solo contiene este `plan.md` por ahora) |
| Alcance de esta sesión | Carpeta + roadmap + **scaffold del proyecto** (Vite+React+TS+Tailwind, mismo stack que Bedly) — el scaffold **no se ejecutó todavía**, quedó pendiente al pausar para resolver el tema de Supabase |
| Proyecto de Supabase | **Debe ser uno nuevo, separado del de Bedly** (confirmado como buena práctica) — **pendiente de crear**, ver sección 2 |
| Auth providers día 1 | Email/password + **Google** OAuth. Otros proveedores (Microsoft, etc.) quedan para después. |
| Multi-tenant | Superadmin (equipo Leadly) crea/administra clientes (tenants) y les asigna líneas de WhatsApp. Cada tenant tiene sus propios usuarios, que ven un layout distinto al del superadmin — mismo patrón que Bedly (`BackofficeLayout` vs `HotelLayout`), pero aquí el "hotel" es un tenant genérico, no necesariamente hotelero. |

---

## 2. Pendiente crítico: resolver la cuenta/organización de Supabase antes de crear nada

Al intentar crear el proyecto de Supabase para Leadly, surgió confusión sobre organizaciones:

- El **conector MCP de Supabase activo en esta sesión** solo ve **una organización**, llamada `"Bedly"` (id `nobkzxpustcxlzfqskih`), con **un solo proyecto**: `"Bedly app"` (`heuxxbfpbtsuklkvbbia`, `ACTIVE_HEALTHY`) — el mismo que usa el repo `Bedly/`. Nada de esto se tocó ni está en riesgo.
- El usuario recordaba una organización **"Lexy"** con varios proyectos, que **no aparece** en este conector — probablemente vive en otra cuenta/login de Supabase.
- Se confirmó evidencia local de esto: existe una carpeta separada `Desktop/Proyectos/Lexy/` con sus propios repos (`lexy-web`, `lexy-pp-worker`, etc.) y sus propios `.env`/config de Supabase, completamente independiente de Bedly. Es muy probable que esa cuenta de Supabase (la que respalda `lexy-web`/`lexy-pp-worker`) sea la organización "Lexy" que el usuario recuerda, y que el MCP de esta sesión esté autenticado contra una cuenta de Supabase distinta (la que se usó para crear "Bedly app").

**Antes de crear el proyecto de Supabase de Leadly, en la próxima sesión hay que decidir con el usuario:**
1. ¿Leadly va en la organización "Bedly" (la que ve este MCP ahora mismo, costo $0/mes confirmado) — probablemente la más simple si el MCP no cambia?
2. ¿O el usuario prefiere conectar/loguear el MCP de Supabase contra la cuenta que tiene la organización "Lexy", y crear Leadly ahí?
3. Ninguna opción es técnicamente mejor que la otra — es una decisión organizativa del usuario (dónde quiere facturar/administrar este proyecto). Lo único que importa técnicamente es que sea un **proyecto de Supabase nuevo y dedicado**, no compartido con Bedly ni con ningún otro producto.

No se debe crear ningún proyecto de Supabase hasta resolver esto explícitamente con el usuario al retomar.

---

## 3. Arquitectura propuesta (adaptada del análisis de seeri + patrones ya probados en Bedly)

### 3.1 Stack técnico
- Frontend: **React 19 + TypeScript + Vite + Tailwind v4** (mismo stack que `bedly-app`, para reusar criterio/velocidad de desarrollo).
- Backend: **ninguno propio** — Supabase (Postgres + RLS + Auth + Storage) consumido directo desde el cliente, más **Supabase Edge Functions** para todo lo que no puede vivir en el navegador (webhook de WhatsApp, llamadas a OpenAI con API keys, sincronización con el dashboard de OpenAI).
- Monorepo sugerido, igual que Bedly: `leadly-app/` (frontend) + `leadly-db/` (migraciones SQL) + `CLAUDE.md` raíz.

### 3.2 Multi-tenancy y roles
- Tabla `tenants` (el "cliente" de Leadly — un negocio que contrata la plataforma). Reemplaza el concepto `hotels` de Bedly, pero genérico (no asume vertical hotelera).
- `profiles` con `role` (`superadmin` | `tenant_admin` | `tenant_staff`, a definir el detalle) + `tenant_id` (null para superadmin), mismo patrón que `profiles.hotel_id` en Bedly.
- RLS: `auth_tenant_id()` / `is_superadmin()` — funciones `SECURITY DEFINER`, mismo patrón exacto que `auth_hotel_id()`/`is_superadmin()` en Bedly (`bedly-db/supabase/migrations/20260729000002_helpers.sql` como referencia directa).
- Dos layouts de frontend: `SuperadminLayout` (gestión de tenants, asignación de líneas de WhatsApp, planes/facturación) y `TenantLayout` (panel del cliente: su asesor de IA, sus conversaciones). Mismo patrón que `BackofficeLayout` vs `HotelLayout` en Bedly.
- Roles/permisos granulares por tenant (como el sistema de `hotel_roles`/`hotel_role_permissions` que ya se construyó en Bedly) — **no necesario para v1**, se puede empezar con roles fijos (`tenant_admin`/`tenant_staff`) y añadir permisos granulares después si un tenant lo pide, replicando el mismo sistema que ya existe en Bedly si hace falta.

### 3.3 Esquema de datos — asesor de WhatsApp con IA (núcleo del producto, ya no es un "add-on")

- **Módulo de permisos / auth**: multi-tenant desde el día 1 (ver 3.2), no hace falta un módulo de permisos separado para "whatsapp" — es el producto entero.
- **`whatsapp_assistants`** — una fila por línea de WhatsApp Business por tenant: credenciales de Meta (`phone_number_id`, `business_account_id`, `access_token` cifrado), `openai_assistant_id`/equivalente (ver spike de la sección 4), `system_prompt`, modelo, `status`.
- **`whatsapp_conversations`** — `tenant_id`, número del contacto, `contact_id` nullable (si el tenant tiene su propio CRM de contactos — a definir si Leadly necesita gestión de contactos propia o es solo el número de WhatsApp), id del thread/conversación de OpenAI, `mode` (ia/humano), `status`.
- **`whatsapp_messages`** — ledger inmutable: dirección, contenido, `wamid`, tokens, `error_message`. Mismo patrón "defensa en profundidad, ledger append-only" que `folio_payments`/`expenses` en Bedly.
- **Function-calling / herramientas de la IA**: a diferencia de Bedly (donde las herramientas eran "consultar disponibilidad"/"crear reserva"), en Leadly el conjunto de herramientas depende del **vertical de cada tenant** — esto es una diferencia de diseño importante frente al plan original de Bedly. Hay que decidir en la próxima sesión: ¿Leadly ofrece herramientas genéricas configurables por tenant (ej. un "conector" a Google Calendar, a un CRM externo, a un webhook propio del tenant), o cada vertical tiene su propio set de herramientas predefinidas (como seeri con Shopify/HubSpot/TiendaNube)? Esto determina buena parte del roadmap de Fase 2+.

### 3.4 Edge Functions (mismo patrón que `admin-create-user` en Bedly)
- `whatsapp-webhook` — recibe el webhook de Meta (handshake `GET` + mensajes entrantes `POST`), valida firma (`X-Hub-Signature-256`) y `verify_token`, resuelve/crea la conversación, inserta el mensaje, debounce de mensajes seguidos.
- `whatsapp-ai-respond` — arma contexto + `system_prompt` del tenant, llama a OpenAI con herramientas, responde por WhatsApp vía Graph API.
- `whatsapp-sync-assistant` — sincroniza cambios de `system_prompt`/modelo hechos en la UI de Leadly contra la API de OpenAI, para que el objeto se vea actualizado también en el dashboard de OpenAI.
- `admin-create-tenant-user` — creación de usuarios de un tenant por parte del superadmin (o por el `tenant_admin` para su propio tenant), mismo patrón que `admin-create-user` de Bedly.

---

## 4. Spikes / decisiones abiertas antes de escribir la primera línea de código

1. **[Bloqueante] Cuenta/organización de Supabase** — ver sección 2. Resolver con el usuario cuál cuenta usar antes de `create_project`.
2. **[Bloqueante] Objeto de OpenAI para "agentes visibles en mi panel"** — confirmar en la documentación *vigente* de OpenAI (el análisis previo se hizo con corte a enero 2026 y puede haber cambiado) cuál es hoy el objeto correcto: la Assistants API clásica (`asst_...`, Threads+Runs — la que usa seeri, anunciada para discontinuarse a mediados de 2026) vs. la Responses API + Agent Builder/Prompts (el reemplazo). La elección determina el modelo de datos (threads+runs vs. responses+`previous_response_id`) y el formato de function-calling.
3. **Proveedor de WhatsApp** — Meta Cloud API directo (como seeri — más barato, pero exige verificación de negocio de Meta, firma de webhook, manejo de ventana de 24h) vs. agregador (Twilio/360dialog/Gupshup — más caro, mucho más simple de integrar, sin necesidad de que cada tenant pase por verificación de Meta).
4. **¿Quién pone la API key de OpenAI?** — ¿Leadly usa una key propia compartida (con límite de tokens por plan de tenant), o cada tenant trae la suya? Afecta el modelo de costos/facturación de Leadly como negocio.
5. **Alcance de "herramientas" por tenant** (ver 3.3) — genérico/configurable vs. vertical-específico predefinido.
6. **Modelo de facturación de Leadly a sus tenants** — ¿planes con límite de conversaciones/mensajes/tokens al estilo `plans`/`subscriptions` de Bedly? Probablemente sí, reusando ese patrón (ya probado y funcionando en Bedly).

---

## 5. Roadmap por fases (borrador, a refinar una vez resueltos los spikes de la sección 4)

### Fase 0 — Fundación: Supabase + auth + multi-tenancy
- Crear proyecto Supabase (bloqueado por sección 2).
- Scaffold `leadly-app/` (Vite+React+TS+Tailwind) y `leadly-db/` (migraciones).
- Esquema base: `tenants`, `profiles` (+ roles), `auth_tenant_id()`/`is_superadmin()`, RLS base.
- Auth: email/password + Google OAuth (Supabase Auth, `signInWithOAuth`).
- `SuperadminLayout` + `TenantLayout`, guards de rutas (mismo patrón `RequireAuth`/`RequireRole` de Bedly).

### Fase 1 — Backoffice del superadmin
- CRUD de tenants (crear cliente, ver detalle, activar/desactivar).
- Asignación de línea de WhatsApp a un tenant.
- Creación de usuarios por tenant (edge function `admin-create-tenant-user`).

### Fase 2 — Núcleo WhatsApp + IA (resolver spikes 2, 3, 4, 5 antes de empezar)
- Esquema `whatsapp_assistants`/`whatsapp_conversations`/`whatsapp_messages`.
- Edge functions `whatsapp-webhook`, `whatsapp-ai-respond`, `whatsapp-sync-assistant`.
- Panel del tenant: conectar número, editor de `system_prompt` con chat de prueba, inbox de conversaciones con toggle IA/humano.

### Fase 3 — Planes y facturación
- `plans`/`subscriptions` al estilo Bedly, límites de mensajes/tokens por plan.
- Backoffice de facturación para el superadmin.

### Fase 4 — Cumplimiento y seguridad
- Ventana de 24h de WhatsApp y plantillas pre-aprobadas.
- Habeas Data / consentimiento por conversación.
- Cifrado en reposo de credenciales (Meta access token, OpenAI key) — evaluar Supabase Vault/`pgsodium`.
- Rate limiting del webhook.

### Fase 5 — Infraestructura y despliegue
- Mismo pendiente que Bedly tenía en pausa: hosting (Vercel/Netlify), dominio, CI, monitoreo de errores, backups. Posiblemente resolverlo aquí primero y aplicar el aprendizaje después a Bedly, o en paralelo.

---

## 6. Cómo continuar en la próxima sesión

1. Abrir Claude Code en `Desktop/Proyectos/Leadly/` (esta carpeta).
2. Resolver el spike de la sección 2 (organización de Supabase) — decidir y crear el proyecto.
3. Resolver el spike de la sección 4.2 (objeto de OpenAI vigente) antes de tocar el esquema de `whatsapp_*`.
4. Retomar desde "Fase 0" del roadmap.
