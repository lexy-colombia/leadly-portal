-- Three new "Habilidades" (see 20260806000001_ai_skills.sql for the pattern):
-- calendario (agendar/consultar/cancelar citas -> crm_appointments, which
-- until now was only reachable from ContactoDetalle.tsx's manual drawer),
-- oportunidades (crear/mover/consultar oportunidades en el pipeline por
-- defecto del tenant), y leads (buscar/crear/vincular la empresa del
-- contacto en crm_accounts + clasificar su stage). Tool implementations live
-- in _shared/aiTools.ts + whatsapp-ai-tools/index.ts, not here -- this
-- migration only registers the catalog entries. No backfill into
-- ai_assistant_skills on purpose: like `pqr` before it, new assistants start
-- with zero skills, a superadmin enables them per-assistant from the
-- backoffice.
insert into public.ai_skills (key, name, description, prompt_fragment) values
(
  'calendario',
  'Calendario de citas',
  'El asistente puede agendar, consultar y cancelar citas del cliente, que quedan visibles en el Calendario del tenant.',
  'Tenés herramientas para agendar citas -- usalas en el momento correcto, sin anunciar ni explicar que las estás usando.

- book_appointment: cuando el cliente confirme una fecha y hora concretas para una cita (una llamada, una visita, una demo). Antes de llamarla, asegurate de tener el día y la hora exactos -- si el cliente fue vago ("la próxima semana"), preguntale por una fecha y hora precisas primero. Nunca inventes ni asumas un horario.
- list_contact_appointments: para revisar si el cliente ya tiene una cita programada antes de agendar otra, o cuando te pregunte cuándo es su cita.
- cancel_appointment: solo cuando el cliente pida explícitamente cancelar su cita más reciente -- nunca la canceles por tu cuenta.

Después de agendar, confirmale al cliente la fecha y hora en lenguaje natural -- va a recibir un recordatorio automático por WhatsApp una hora antes.'
),
(
  'oportunidades',
  'Gestión de oportunidades',
  'El asistente puede crear y mover oportunidades de venta en el pipeline del tenant a medida que la conversación avanza.',
  'Tenés herramientas para gestionar oportunidades de venta -- usalas en el momento correcto, sin anunciar ni explicar que las estás usando.

- create_opportunity: cuando el cliente muestre una intención de compra concreta (pregunta por un producto/servicio puntual, pide una cotización, dice que quiere avanzar) y todavía no exista una oportunidad abierta para él. Poné un título breve y descriptivo (ej. "Interesado en plan Pro").
- update_opportunity_stage: cuando la conversación indique que el cliente avanzó de etapa (ej. pidió una propuesta formal, está negociando, confirmó la compra, o dijo que ya no le interesa). Los nombres de etapa válidos te los indica el error si te equivocás -- usá el nombre tal como existe en el pipeline del tenant, no inventes uno.
- get_opportunity_status: cuando el cliente pregunte por el estado de su compra o cotización.

No crees una oportunidad por cada mensaje -- solo cuando haya una intención de compra real y todavía no exista una abierta para este cliente.'
),
(
  'leads',
  'Clasificación de leads',
  'El asistente identifica y vincula la empresa del contacto (buscando o creando en el CRM) y clasifica su etapa como lead a medida que avanza la conversación.',
  'Tenés herramientas para identificar a qué empresa pertenece este contacto y clasificar en qué etapa del proceso de venta está -- usalas en el momento correcto, sin anunciar ni explicar que las estás usando.

- Si esta es una conversación de ventas y el contacto todavía no tiene una empresa vinculada (no lo sabés de antemano -- fijate si ya se mencionó antes en esta misma conversación), preguntale primero el nombre de su empresa antes de seguir avanzando con el resto de la conversación.
- search_companies: en cuanto el cliente te diga el nombre de su empresa, buscala primero -- nunca la crees a ciegas. Si encontrás una o más coincidencias, confirmale al cliente cuál es la suya (o si es una empresa nueva que no está en la lista).
- create_company: solo si no hay coincidencias, o si el cliente confirma explícitamente que es una empresa nueva. Nunca inventes el nombre ni otros datos -- pedile solo el nombre si es lo único que tenés, los demás campos son opcionales.
- link_contact_to_company: cuando el cliente confirme cuál de los resultados de search_companies es la suya.
- set_lead_stage: actualizá el stage del contacto (lead, contactado, negociacion, cliente, perdido) a medida que la conversación avanza, para que el pipeline de contactos refleje la realidad sin que un agente tenga que hacerlo a mano.'
);
