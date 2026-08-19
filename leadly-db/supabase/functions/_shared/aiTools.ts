// Shared catalog of tools the AI can call during a WhatsApp conversation --
// same name/description/parameters schema is used by whatsapp-ai-respond (to
// build each provider's `tools` payload) and by whatsapp-ai-tools (to know
// what a given function_name means), so the two can never drift apart.
//
// Deliberately no `pqr_id` parameter on add_pqr_update/update_pqr_status:
// the LLM has no reliable way to remember an id it saw in an earlier turn
// (context is rebuilt stateless per-turn, see CLAUDE.md 3.3), so both
// resolve to "the contact's most recent PQR" server-side instead of trusting
// an id the model would have to invent or misremember.
export interface AiToolDefinition {
  name: string;
  // Which ai_skills.key this tool belongs to -- whatsapp-ai-respond only
  // offers a tool to the model if the assistant has that skill enabled (see
  // ai_assistant_skills). Adding a genuinely new tool always requires a code
  // change here + an executor case in whatsapp-ai-tools anyway, so this
  // mapping deliberately lives in code, not in the ai_skills table itself --
  // there's no way for a DB row to reference a tool implementation that
  // doesn't exist.
  skill: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const AI_TOOLS: AiToolDefinition[] = [
  {
    name: "create_pqr",
    skill: "pqr",
    description:
      "Crea una Petición, Queja o Reclamo (PQR) formal para el cliente de esta conversación. Úsala cuando el cliente exprese una queja o un reclamo, o haga una petición formal que un agente humano deba dar seguimiento.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["peticion", "queja", "reclamo"], description: "Tipo de caso." },
        subject: { type: "string", description: "Resumen breve del caso, en una línea." },
        description: { type: "string", description: "Detalle completo de lo que el cliente reportó." },
      },
      required: ["type", "subject", "description"],
    },
  },
  {
    name: "create_note",
    skill: "pqr",
    description:
      "Deja una nota libre en el historial del cliente, para información útil que no amerita un PQR (ej. el cliente mencionó un dato de contacto o un detalle de contexto).",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Contenido de la nota." },
      },
      required: ["content"],
    },
  },
  {
    name: "add_pqr_update",
    skill: "pqr",
    description:
      "Agrega un seguimiento al PQR más reciente de este cliente -- úsala cuando el cliente vuelva a escribir sobre un caso que ya había reportado antes. Si el cliente no tiene ningún PQR todavía, usa create_pqr en vez de esta función.",
    parameters: {
      type: "object",
      properties: {
        content: { type: "string", description: "Texto del seguimiento." },
      },
      required: ["content"],
    },
  },
  {
    name: "update_pqr_status",
    skill: "pqr",
    description:
      "Cambia el estado del PQR más reciente de este cliente. Solo debe usarse cuando el cliente confirma explícitamente que su caso se resolvió o pide cancelarlo -- no cambies el estado por tu cuenta sin esa confirmación.",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["abierto", "en_proceso", "resuelto", "cerrado"], description: "Nuevo estado del PQR." },
      },
      required: ["status"],
    },
  },
  {
    name: "get_pqr_status",
    skill: "pqr",
    description:
      "Consulta el PQR más reciente de este cliente: su código, tipo, asunto, estado actual, sus últimos seguimientos, y las imágenes (attachments, con su id) adjuntas al caso o a esos seguimientos. Úsala cuando el cliente pregunte cómo va su caso, pida el número/código de su PQR, pregunte por el estado de un reclamo, petición o queja anterior, o pregunte si hay una foto/soporte adjunto.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "send_attachment",
    skill: "pqr",
    description:
      "Envía por WhatsApp, directo al cliente, una imagen que ya está adjunta a su PQR más reciente o a uno de sus seguimientos (por ejemplo, un comprobante de reembolso). Usa el attachment_id que te devolvió get_pqr_status -- consulta esa función primero si no sabés el id. Solo puede enviar adjuntos del caso más reciente del cliente.",
    parameters: {
      type: "object",
      properties: {
        attachment_id: { type: "string", description: "id del adjunto a enviar, tal como lo devolvió get_pqr_status." },
      },
      required: ["attachment_id"],
    },
  },
  {
    name: "book_appointment",
    skill: "calendario",
    description:
      "Agenda una cita con el cliente en una fecha y hora concretas -- solo cuando el cliente confirmó un día y hora exactos, nunca con una fecha vaga o asumida. La cita queda visible en el Calendario del tenant y el cliente recibe un recordatorio automático por WhatsApp una hora antes.",
    parameters: {
      type: "object",
      properties: {
        scheduled_at: { type: "string", description: "Fecha y hora de la cita en formato ISO 8601 (ej. 2026-08-15T15:00:00-05:00)." },
        notes: { type: "string", description: "Motivo o notas de la cita (opcional)." },
      },
      required: ["scheduled_at"],
    },
  },
  {
    name: "list_contact_appointments",
    skill: "calendario",
    description: "Lista las próximas citas activas de este cliente -- úsala antes de agendar una nueva (para no duplicar) o cuando el cliente pregunte cuándo es su cita.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_appointment",
    skill: "calendario",
    description: "Cancela la cita activa más próxima de este cliente. Solo cuando el cliente lo pida explícitamente -- nunca la canceles por tu cuenta.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_pipelines",
    skill: "oportunidades",
    description:
      "Lista los pipelines activos del tenant (nombre y descripción de cada uno). Úsala antes de create_opportunity si no sabés todavía qué pipelines existen o para qué sirve cada uno -- el tenant puede tener más de uno (ej. Ventas, Soporte y Postventa, Onboarding) y cada caso va en el que corresponda.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_opportunity",
    skill: "oportunidades",
    description:
      "Crea una oportunidad para este cliente en el pipeline que corresponda, cuando la conversación muestre una necesidad concreta y todavía no tenga una oportunidad abierta en ese pipeline. No la crees por cada mensaje -- solo ante una necesidad real. Si no sabés qué pipelines existen, consultá list_pipelines primero -- nunca inventes un nombre de pipeline.",
    parameters: {
      type: "object",
      properties: {
        pipeline_name: { type: "string", description: "Nombre exacto del pipeline donde crearla, tal como lo devolvió list_pipelines (ej. \"Ventas\", \"Soporte y Postventa\", \"Onboarding de clientes\")." },
        title: { type: "string", description: "Título breve y descriptivo de la oportunidad (ej. \"Interesado en plan Pro\")." },
        value: { type: "number", description: "Valor estimado del negocio, si se conoce (opcional)." },
        priority: { type: "string", enum: ["baja", "media", "alta"], description: "Prioridad de la oportunidad (opcional, por defecto media)." },
        expected_close_date: { type: "string", description: "Fecha estimada de cierre en formato YYYY-MM-DD (opcional)." },
        description: { type: "string", description: "Detalle de lo que el cliente busca (opcional)." },
      },
      required: ["pipeline_name", "title"],
    },
  },
  {
    name: "update_opportunity_stage",
    skill: "oportunidades",
    description:
      "Mueve la oportunidad abierta más reciente de este cliente a otra etapa del pipeline, cuando la conversación indique que avanzó (pidió una propuesta, está negociando, confirmó la compra, o ya no le interesa). Usa el nombre de etapa tal como existe en el pipeline del tenant.",
    parameters: {
      type: "object",
      properties: {
        stage_name: { type: "string", description: "Nombre exacto de la etapa destino (ej. \"Propuesta\", \"Negociación\", \"Ganado\", \"Perdido\")." },
      },
      required: ["stage_name"],
    },
  },
  {
    name: "get_opportunity_status",
    skill: "oportunidades",
    description: "Consulta la oportunidad abierta más reciente de este cliente: título, etapa actual, valor y estado. Úsala cuando el cliente pregunte por el estado de su compra o cotización.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "flag_interest_for_followup",
    skill: "oportunidades",
    description:
      "Registra una tarea de seguimiento para que un agente humano se ponga en contacto con este cliente, para cuando mostró interés en un producto/servicio pero la intención de compra todavía no es clara o falta calificarla mejor (no es el momento de ofrecer una cotización todavía). No crea ni confirma ninguna cotización ni venta -- solo dejá constancia para que un agente siga la conversación.",
    parameters: {
      type: "object",
      properties: {
        product_name: { type: "string", description: "Producto o servicio puntual por el que mostró interés." },
        note: { type: "string", description: "Contexto breve para el agente que va a hacer el seguimiento (opcional)." },
      },
      required: ["product_name"],
    },
  },
  {
    name: "set_lead_stage",
    skill: "leads",
    description: "Actualiza la etapa del contacto en el pipeline de contactos, a medida que la conversación avanza.",
    parameters: {
      type: "object",
      properties: {
        stage: { type: "string", enum: ["lead", "contactado", "negociacion", "cliente", "perdido"], description: "Nueva etapa del contacto." },
      },
      required: ["stage"],
    },
  },
  {
    name: "list_catalog_categories",
    skill: "catalogo",
    description:
      "Lista las categorías de productos del tenant (nombre y descripción), hasta 5 -- la herramienta misma limita el resultado, no hace falta que vos recortes la lista. Úsala para sugerirle categorías al cliente cuando no haya pedido un producto puntual (ej. al iniciar la conversación).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_catalog_products",
    skill: "catalogo",
    description:
      "Busca productos activos del catálogo del tenant por nombre y/o categoría, con su nombre, precio, categorías (un producto puede tener varias) y descripción completa (no incluye stock -- eso solo se revisa al momento de crear una cotización, ver create_quote). La descripción puede incluir detalle extendido según el rubro del tenant (ej. para instituciones educativas: duración, modalidad, horarios, plan de estudios, requisitos de admisión, título otorgado) -- si el cliente pide ese tipo de detalle sobre un producto puntual, usá esta herramienta (con `search` por el nombre exacto) y respondé con lo que la descripción realmente dice, nunca lo inventes. Úsala cuando el cliente pregunte qué productos hay, pida precios o detalles, o mencione algo que querés confirmar que existe en el catálogo antes de ofrecerlo. Si pasás solo `category` (sin `search`), te devuelve hasta 5 productos de esa categoría, ya priorizados internamente -- mostralos en ese orden.",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Texto a buscar en el nombre del producto (opcional, ej. \"camiseta\")." },
        category: { type: "string", description: "Nombre de categoría para filtrar (opcional, ej. \"Ropa\"). Si se pasa sola, devuelve hasta 5 productos destacados de esa categoría." },
      },
      required: [],
    },
  },
  {
    name: "send_product_image",
    skill: "catalogo",
    description: "Envía por WhatsApp, directo al cliente, la foto principal de un producto del catálogo. Usa el nombre exacto que te devolvió list_catalog_products.",
    parameters: {
      type: "object",
      properties: {
        product_name: { type: "string", description: "Nombre exacto del producto, tal como lo devolvió list_catalog_products." },
      },
      required: ["product_name"],
    },
  },
  {
    name: "create_quote",
    skill: "ventas",
    description:
      "Crea una cotización para este cliente con uno o más productos del catálogo. Cotización y venta son la misma entidad -- crearla acá la deja en estado \"cotizacion\" y reserva el stock pedido (no lo descuenta todavía). Si no sabés el nombre exacto de un producto o su precio, consultá list_catalog_products primero -- nunca inventes un producto ni un precio.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Líneas de la cotización.",
          items: {
            type: "object",
            properties: {
              product_name: { type: "string", description: "Nombre exacto del producto, tal como lo devolvió list_catalog_products." },
              quantity: { type: "number", description: "Cantidad pedida." },
            },
            required: ["product_name", "quantity"],
          },
        },
        notes: { type: "string", description: "Notas adicionales sobre el pedido (opcional)." },
      },
      required: ["items"],
    },
  },
  {
    name: "get_quote_status",
    skill: "ventas",
    description: "Consulta la cotización o venta más reciente de este cliente: número, estado, productos, total, notas que un agente haya dejado (si hay alguna, comunicásela al cliente), y cuánto lleva pagado / cuánto falta (total_paid/balance_due). Úsala cuando el cliente pregunte por el estado de su pedido/cotización, o por su saldo pendiente.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_order_comment",
    skill: "ventas",
    description: "Registra una observación del cliente sobre la cotización/venta más reciente (ej. una instrucción de entrega, un pedido especial) -- queda como un comentario con fecha, visible para el equipo en el detalle de la venta. No la uses para datos que ya tienen su propio lugar (productos, direcciones) -- solo para observaciones sueltas que no encajan en otro campo.",
    parameters: {
      type: "object",
      properties: {
        comment: { type: "string", description: "Observación del cliente, en sus propias palabras o resumida." },
      },
      required: ["comment"],
    },
  },
  {
    name: "confirm_quote",
    skill: "ventas",
    description:
      "Confirma la cotización más reciente de este cliente como venta (pasa de \"cotizacion\" a \"confirmada\") -- solo cuando el cliente confirme explícitamente que quiere seguir adelante con la compra. El stock reservado se descuenta del inventario real en ese momento.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_quote",
    skill: "ventas",
    description:
      "Cancela la cotización más reciente de este cliente (solo si todavía está en estado \"cotizacion\", no una venta ya confirmada) y libera el stock que tenía reservado. Solo cuando el cliente lo pida explícitamente.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "complete_sale",
    skill: "ventas",
    description:
      "Cierra el ciclo completo: marca la venta más reciente de este cliente (ya confirmada) como \"entregada\". Es el último paso del flujo cotizar -> confirmar -> completar -- usala cuando el cliente confirme que recibió su pedido, o inmediatamente después de confirm_quote si la venta se completa en el momento (ej. un producto digital o un pedido que no requiere envío). No hace falta pedir permiso para usarla si el contexto de la conversación ya deja claro que el pedido está resuelto.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_contact_addresses",
    skill: "ventas",
    description: "Lista las direcciones guardadas de este cliente (envío y/o facturación), con su id. Consultala antes de pedir una dirección nueva -- si ya hay una marcada como predeterminada, confirmale al cliente si es la misma antes de pedirle que la repita.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "save_contact_address",
    skill: "ventas",
    description:
      "Guarda o actualiza una dirección de este cliente, y opcionalmente la aplica a su cotización/venta más reciente. Para reutilizar una dirección ya guardada (ej. el cliente dijo \"la misma de siempre\"), pasá su address_id junto con apply_as_shipping/apply_as_billing sin repetir el resto de los campos. Para una dirección nueva, pedile al cliente los datos completos -- nunca inventes ni completes una dirección a medias.",
    parameters: {
      type: "object",
      properties: {
        address_id: { type: "string", description: "Id de una dirección ya guardada (de list_contact_addresses) para actualizarla o reutilizarla, en vez de crear una nueva." },
        label: { type: "string", description: "Nombre corto para identificarla (ej. \"Casa\", \"Oficina\"), opcional." },
        is_shipping: { type: "boolean", description: "Si es una dirección de envío (por defecto true)." },
        is_billing: { type: "boolean", description: "Si es una dirección/datos de facturación (por defecto false)." },
        recipient_name: { type: "string", description: "A nombre de quién se recibe o factura, si es distinto del contacto (opcional)." },
        phone: { type: "string", description: "Teléfono de contacto para la entrega (opcional)." },
        tax_id: { type: "string", description: "Documento/NIT para facturación, si aplica (opcional)." },
        line1: { type: "string", description: "Dirección (calle, número, barrio). Requerida si es una dirección nueva." },
        line2: { type: "string", description: "Complemento (apto, torre, indicaciones), opcional." },
        city: { type: "string", description: "Ciudad (opcional)." },
        state_province: { type: "string", description: "Departamento/estado/provincia (opcional)." },
        postal_code: { type: "string", description: "Código postal (opcional)." },
        country: { type: "string", description: "País (opcional, por defecto Colombia)." },
        notes: { type: "string", description: "Instrucciones adicionales de entrega (opcional)." },
        apply_as_shipping: { type: "boolean", description: "Si aplicar esta dirección como la de envío de la cotización/venta más reciente del cliente." },
        apply_as_billing: { type: "boolean", description: "Si aplicar esta dirección como la de facturación de la cotización/venta más reciente del cliente." },
      },
      required: [],
    },
  },
  {
    name: "generate_payment_link",
    skill: "wompi",
    description:
      "Genera un enlace de pago real de Wompi (la cuenta del propio tenant, no la de Leadly) y devuelve la URL para compartir con el cliente. Solo cuando ya sabés el monto exacto a cobrar y el cliente confirmó que quiere pagar -- nunca inventes un monto.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "Descripción breve del cobro (ej. \"Orden #1234 - Juan Pérez\")." },
        amount: { type: "number", description: "Monto a cobrar en pesos colombianos (COP), sin centavos (ej. 50000 = $50.000 COP)." },
        reference: { type: "string", description: "Referencia única del cobro, opcional (si no se pasa, se genera una automáticamente)." },
      },
      required: ["description", "amount"],
    },
  },
  {
    name: "hubspot_sync_contact",
    skill: "hubspot",
    description:
      "Crea o actualiza el contacto de este cliente en la cuenta de HubSpot del tenant (el teléfono se toma automáticamente del contacto de esta conversación). Llamala en cuanto tengas al menos el email del cliente.",
    parameters: {
      type: "object",
      properties: {
        email: { type: "string", description: "Correo del cliente." },
        firstname: { type: "string", description: "Nombre (opcional)." },
        lastname: { type: "string", description: "Apellido (opcional)." },
        company: { type: "string", description: "Empresa del cliente (opcional)." },
        jobtitle: { type: "string", description: "Cargo del cliente (opcional)." },
      },
      required: ["email"],
    },
  },
  {
    name: "hubspot_list_deal_pipelines",
    skill: "hubspot",
    description: "Lista los pipelines y etapas de negocios (deals) de la cuenta de HubSpot del tenant. Consultala antes de hubspot_create_deal si no sabés el nombre exacto del pipeline/etapa -- nunca los inventes.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "hubspot_create_deal",
    skill: "hubspot",
    description:
      "Crea un negocio (deal) en HubSpot vinculado al contacto de este cliente -- el contacto debe estar sincronizado primero con hubspot_sync_contact. Usá los nombres exactos de pipeline/etapa que devolvió hubspot_list_deal_pipelines.",
    parameters: {
      type: "object",
      properties: {
        dealname: { type: "string", description: "Nombre del negocio (ej. \"Plan Pro - Juan Pérez\")." },
        pipeline_name: { type: "string", description: "Nombre exacto del pipeline, tal como lo devolvió hubspot_list_deal_pipelines." },
        dealstage_name: { type: "string", description: "Nombre exacto de la etapa dentro de ese pipeline." },
        amount: { type: "number", description: "Valor estimado del negocio, si se conoce (opcional)." },
        description: { type: "string", description: "Detalle del negocio (opcional)." },
      },
      required: ["dealname", "pipeline_name", "dealstage_name"],
    },
  },
  {
    name: "shopify_search_products",
    skill: "shopify",
    description: "Busca productos en la tienda Shopify real del tenant (no el catálogo propio de Leadly). Úsala cuando el catálogo del negocio viva en Shopify.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto o filtro de búsqueda (ej. \"camiseta\", \"title:*gift card*\")." },
      },
      required: ["query"],
    },
  },
  {
    name: "shopify_search_customer_by_phone",
    skill: "shopify",
    description: "Busca el perfil de cliente en Shopify correspondiente a este contacto (usa su teléfono automáticamente, no hace falta pedirlo).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "shopify_search_orders",
    skill: "shopify",
    description: "Busca los pedidos de Shopify del cliente de esta conversación (nunca de otros clientes), para consultar su estado. Si el cliente dio un número de pedido, pasalo en query para acotar entre sus propios pedidos.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Texto para acotar entre los pedidos de este cliente (ej. \"1001\"), opcional -- sin esto devuelve sus pedidos más recientes." },
      },
      required: [],
    },
  },
];

/** Only ever offer the model tools whose skill is enabled for this
 * assistant (see ai_assistant_skills) -- a tool that isn't in the `tools`
 * payload sent to the provider is literally impossible for the model to
 * call, which is a much stronger guarantee than hoping the system_prompt
 * text alone stops it from trying. */
export function toolsForSkills(enabledSkillKeys: Set<string>): AiToolDefinition[] {
  return AI_TOOLS.filter((tool) => enabledSkillKeys.has(tool.skill));
}

/** True if `functionName` belongs to a skill in `enabledSkillKeys` -- used by
 * whatsapp-ai-tools as a defense-in-depth check, in case anything ever calls
 * it with a function_name that whatsapp-ai-respond wouldn't have offered. */
export function isToolAllowed(functionName: string, enabledSkillKeys: Set<string>): boolean {
  const tool = AI_TOOLS.find((t) => t.name === functionName);
  return !!tool && enabledSkillKeys.has(tool.skill);
}
