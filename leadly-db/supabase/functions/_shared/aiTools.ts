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
      "Busca productos activos del catálogo del tenant por nombre, categoría y/o marca, con su nombre, precio, categorías (un producto puede tener varias) y descripción completa (no incluye stock -- eso solo se revisa al momento de crear una cotización, ver create_quote). La descripción puede incluir detalle extendido según el rubro del tenant (ej. para instituciones educativas: duración, modalidad, horarios, plan de estudios, requisitos de admisión, título otorgado) -- si el cliente pide ese tipo de detalle sobre un producto puntual, usá esta herramienta (con `search` por el nombre exacto) y respondé con lo que la descripción realmente dice, nunca lo inventes. Úsala cuando el cliente pregunte qué productos hay, pida precios o detalles, o mencione algo que querés confirmar que existe en el catálogo antes de ofrecerlo. Si pasás solo `category` y/o `brand` (sin `search`), te devuelve hasta 5 productos ya priorizados internamente -- mostralos en ese orden. Cuando `search` deja un único producto (típico de un pedido de detalle), la respuesta trae `image_sent: true|false` -- la foto ya se mandó sola en ese caso, NO llames send_product_image de nuevo para el mismo producto en el mismo turno. Si viene en false, avisale al cliente con naturalidad que todavía no hay foto cargada de ese producto.",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Texto a buscar en el nombre del producto (opcional, ej. \"camiseta\")." },
        category: { type: "string", description: "Nombre de categoría para filtrar (opcional, ej. \"Ropa\"). Si se pasa sola, devuelve hasta 5 productos destacados de esa categoría." },
        brand: { type: "string", description: "Nombre de marca para filtrar (opcional, ej. \"Nike\"). Si se pasa sola, devuelve hasta 5 productos destacados de esa marca." },
      },
      required: [],
    },
  },
  {
    name: "send_product_image",
    skill: "catalogo",
    description:
      "Envía por WhatsApp, directo al cliente, la foto principal de un producto del catálogo -- ya la está viendo en su pantalla apenas esta herramienta devuelve éxito, es una foto real, no una descripción. Usa el nombre exacto que te devolvió list_catalog_products. Tu mensaje de texto después de esto es solo un complemento breve (ej. preguntar si quiere avanzar) -- nunca repitas ni \"muestres\" la imagen de nuevo con markdown/links (WhatsApp no los renderiza, el cliente solo ve texto roto), y nunca digas que no podés enviar imágenes: encontrado en vivo, dijiste eso mismo justo después de haber enviado una con éxito.",
    parameters: {
      type: "object",
      properties: {
        product_name: { type: "string", description: "Nombre exacto del producto, tal como lo devolvió list_catalog_products." },
      },
      required: ["product_name"],
    },
  },
  {
    name: "list_product_variants",
    skill: "catalogo",
    description:
      "Consulta si un producto tiene variantes (ej. color, talla) y, si las tiene, las lista con su precio propio. Llamala SIEMPRE antes de crear una cotización con un producto que pueda tener variantes -- si `has_variants` da true, tenés que preguntarle al cliente cuál quiere (usando el `label` exacto de cada una) antes de pasar a create_quote/add_item_to_quote. Si `has_variants` da false, el producto no tiene variantes y no hace falta preguntar nada.",
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
      "Crea una cotización para este cliente con uno o más productos del catálogo. Cotización y venta son la misma entidad -- crearla acá la deja en estado \"cotizacion\", todavía sin tocar el inventario (eso pasa recién en confirm_quote). Si no sabés el nombre exacto de un producto o su precio, consultá list_catalog_products primero -- nunca inventes un producto ni un precio. Si un producto tiene variantes (list_product_variants con has_variants=true) y no pasás `variant`, la línea se rechaza -- consultá list_product_variants y confirmá con el cliente antes de llamar a esta herramienta. La respuesta incluye `billing_address_on_file`: si viene en false, es el momento de pedirle al cliente sus datos de FACTURACIÓN (no de envío todavía -- eso se pide recién si confirma la compra) y guardarlos con save_contact_address (is_billing: true).",
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
              variant: {
                type: "string",
                description:
                  "OBLIGATORIO si el producto tiene variantes -- label exacto de list_product_variants, ej. \"Rojo\". Si el cliente pide unidades de colores/tallas distintos (ej. \"una azul y una rojo\"), cada línea es un item separado con su propio variant -- nunca los agrupes en una sola línea ni dejes variant vacío. Si ya intentaste esta herramienta y te rechazó una línea por falta de variant, tu próxima llamada tiene que incluirlo -- repetir la misma llamada sin variant vuelve a fallar exactamente igual.",
              },
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
    name: "add_item_to_quote",
    skill: "ventas",
    description:
      "Agrega uno o más productos a la cotización más reciente de este cliente, solo si todavía está en estado \"cotizacion\" (no una venta ya confirmada). Úsala cuando el cliente pida sumar algo a un pedido que ya armaste, en vez de crear una cotización nueva. Si no sabés el nombre exacto de un producto o su precio, consultá list_catalog_products primero -- nunca inventes un producto ni un precio. Mismo requisito de variante que create_quote: si el producto tiene variantes, pasá `variant` (de list_product_variants) o la línea se rechaza.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Líneas a agregar.",
          items: {
            type: "object",
            properties: {
              product_name: { type: "string", description: "Nombre exacto del producto, tal como lo devolvió list_catalog_products." },
              variant: {
                type: "string",
                description:
                  "OBLIGATORIO si el producto tiene variantes -- label exacto de list_product_variants, ej. \"Rojo\". Si el cliente pide unidades de colores/tallas distintos (ej. \"una azul y una rojo\"), cada línea es un item separado con su propio variant -- nunca los agrupes en una sola línea ni dejes variant vacío. Si ya intentaste esta herramienta y te rechazó una línea por falta de variant, tu próxima llamada tiene que incluirlo -- repetir la misma llamada sin variant vuelve a fallar exactamente igual.",
              },
              quantity: { type: "number", description: "Cantidad pedida." },
            },
            required: ["product_name", "quantity"],
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "get_quote_status",
    skill: "ventas",
    description: "Consulta la cotización o venta más reciente de este cliente: número, estado, productos, total, notas que un agente haya dejado (si hay alguna, comunicásela al cliente), y cuánto lleva pagado / cuánto falta (total_paid/balance_due). Úsala cuando el cliente pregunte por el estado de su pedido/cotización, o por su saldo pendiente. `status` es el valor crudo (cotizacion/confirmada/cancelada); `status_label` es el texto ya listo para decirle al cliente -- usalo en vez de inventar tu propia palabra a partir de `status`.",
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
      "Confirma la cotización más reciente de este cliente como venta (pasa de \"cotizacion\" a \"confirmada\") -- solo cuando el cliente confirme explícitamente que quiere seguir adelante con la compra. El inventario real se descuenta ahí mismo. Esta es la etapa en la que se pide la dirección de ENVÍO (no antes). La herramienta exige que ya exista una dirección de facturación y una de envío guardadas -- si falta alguna, en vez de confirmar devuelve { blocked: true, reason: \"billing_address_required\" | \"shipping_address_required\" } y no cambia nada. Ante eso, pedile al cliente el dato que falta (nunca lo inventes), guardalo con save_contact_address, y recién ahí volvé a llamar confirm_quote. Si confirma con éxito, la respuesta trae `status_label: \"Pedido confirmado (venta en firme)\"` -- usá ese texto (o una paráfrasis que mantenga la idea de \"pedido/venta confirmada\") en tu mensaje al cliente. Una vez que esto se ejecutó, dejá de llamarlo \"cotización\": ya es una compra en firme, no una estimación de precio.\n\nAl confirmar con éxito, la respuesta también resuelve el pago sola -- nunca llames generate_payment_link/charge_sale_to_credit por tu cuenta después de esto salvo en el caso que se explica abajo, ya se hizo o se te está pidiendo que preguntes: `payment_method: \"wompi\"` + `checkout_url` (ya se generó el link, compartíselo tal cual en tu misma respuesta), `payment_method: \"credito\"` + `payment_charged: true` (ya se cargó a la cuenta de crédito del cliente, solo confirmaselo), `payment_options: [\"credito\",\"wompi\"]` (hay más de una forma de cobrar disponible -- esta es la ÚNICA situación en la que preguntás al cliente cuál prefiere, y recién ahí llamás charge_sale_to_credit o generate_payment_link según lo que elija), o `payment_pending: true` (no hay ninguna forma de cobro automática disponible -- decile al cliente que el pago queda pendiente y que un agente se va a poner en contacto).",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "cancel_quote",
    skill: "ventas",
    description:
      "Cancela la cotización más reciente de este cliente (solo si todavía está en estado \"cotizacion\", no una venta ya confirmada). No hay stock que liberar -- una cotización nunca lo tocó. Solo cuando el cliente lo pida explícitamente.",
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
    name: "get_dispatch_status",
    skill: "ventas",
    description:
      "Consulta el despacho más reciente de la venta más reciente de este cliente: transportadora, número y link de seguimiento, estado actual, y un historial breve de cambios de estado. Úsala cuando el cliente pregunte dónde está su pedido o cuándo llega. Si todavía no se generó ningún despacho, te lo indica -- no inventes un estado de envío.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_return",
    skill: "ventas",
    description:
      "Solicita una devolución sobre la venta más reciente de este cliente -- solo aplica si esa venta ya quedó marcada como entregada (ver complete_sale/get_dispatch_status), y solo sobre productos que efectivamente están en esa venta (si el nombre o la cantidad no coinciden con lo comprado, la herramienta lo rechaza). Queda registrada para que un agente humano la revise y decida la resolución (reembolso, nota crédito, cambio) -- vos nunca decidís ni comunicás un reembolso concreto, solo confirmale al cliente que quedó registrada.",
    parameters: {
      type: "object",
      properties: {
        items: {
          type: "array",
          description: "Productos a devolver, tal como aparecen en la venta.",
          items: {
            type: "object",
            properties: {
              product_name: { type: "string", description: "Nombre del producto tal como aparece en la venta (ver get_quote_status)." },
              quantity: { type: "number", description: "Cantidad a devolver." },
            },
            required: ["product_name", "quantity"],
          },
        },
        reason: { type: "string", description: "Motivo de la devolución, en palabras del cliente." },
      },
      required: ["items", "reason"],
    },
  },
  {
    name: "get_return_status",
    skill: "ventas",
    description: "Consulta la devolución más reciente de este cliente: estado, motivo, y su resolución si un agente ya la resolvió. Úsala cuando el cliente pregunte por el estado de una devolución que ya pidió.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_client_profile",
    skill: "clientes",
    description: "Devuelve los datos guardados del contacto de esta conversación (nombre completo, documento de identidad, email, y credit_enabled -- si tiene crédito/fiado habilitado). Úsala antes de pedirle un dato al cliente, para no preguntar algo que ya está cargado.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_client_profile",
    skill: "clientes",
    description:
      "Guarda o actualiza datos del contacto de esta conversación -- nunca de otra persona. Actualiza solo los campos que recibe. Necesario antes de facturar una venta (documento de identidad) o para completar el nombre si el de WhatsApp no es el nombre real del cliente.",
    parameters: {
      type: "object",
      properties: {
        full_name: { type: "string", description: "Nombre completo del cliente (opcional)." },
        document_type: { type: "string", enum: ["NIT", "CC", "CE", "RUC", "RFC", "PASAPORTE", "OTRO"], description: "Tipo de documento de identidad (opcional)." },
        document_number: { type: "string", description: "Número de documento de identidad (opcional)." },
        email: { type: "string", description: "Correo electrónico del cliente (opcional)." },
      },
      required: [],
    },
  },
  {
    name: "list_contact_addresses",
    skill: "clientes",
    description: "Lista las direcciones guardadas de este cliente (envío y/o facturación), con su id. Consultala antes de pedir una dirección nueva -- si ya hay una marcada como predeterminada, confirmale al cliente si es la misma antes de pedirle que la repita.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "save_contact_address",
    skill: "clientes",
    description:
      "Guarda o actualiza una dirección de este cliente, y opcionalmente la aplica a su cotización/venta más reciente. Para reutilizar una dirección ya guardada (ej. el cliente dijo \"la misma de siempre\"), pasá su address_id junto con apply_as_shipping/apply_as_billing sin repetir el resto de los campos. Para una dirección NUEVA: pedile al cliente los datos reales completos -- nunca inventes ni completes una dirección a medias, ni con un valor de relleno tipo \"no registrada\" o \"pendiente\" solo para poder avanzar (la herramienta lo rechaza igual). line1 y city son obligatorios en una dirección nueva, y hay que indicar explícitamente is_shipping o is_billing (no hay un valor por defecto) según en qué paso del flujo de venta estás: dirección de FACTURACIÓN al cotizar, dirección de ENVÍO recién si el cliente confirma la compra.",
    parameters: {
      type: "object",
      properties: {
        address_id: { type: "string", description: "Id de una dirección ya guardada (de list_contact_addresses) para actualizarla o reutilizarla, en vez de crear una nueva." },
        label: { type: "string", description: "Nombre corto para identificarla (ej. \"Casa\", \"Oficina\"), opcional." },
        is_shipping: { type: "boolean", description: "Si es una dirección de envío. Obligatorio (junto con is_billing) al crear una dirección nueva -- no tiene valor por defecto." },
        is_billing: { type: "boolean", description: "Si es una dirección/datos de facturación. Obligatorio (junto con is_shipping) al crear una dirección nueva -- no tiene valor por defecto." },
        recipient_name: { type: "string", description: "A nombre de quién se recibe o factura, si es distinto del contacto (opcional)." },
        phone: { type: "string", description: "Teléfono de contacto para la entrega (opcional)." },
        tax_id: { type: "string", description: "Documento/NIT para facturación, si aplica (opcional)." },
        line1: { type: "string", description: "Dirección real (calle, número, barrio) tal como te la dio el cliente. Requerida si es una dirección nueva -- nunca un valor inventado." },
        line2: { type: "string", description: "Complemento (apto, torre, indicaciones), opcional." },
        city: { type: "string", description: "Ciudad. Requerida si es una dirección nueva." },
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
      "Genera un enlace de pago real de Wompi (la cuenta del propio tenant, no la de Leadly) por el pedido confirmado más reciente del cliente, y devuelve la URL para compartir. Sin parámetros -- el monto NUNCA lo elegís vos: la herramienta cobra automáticamente el saldo pendiente exacto de ese pedido (total menos lo ya pagado), para que nunca puedas cobrar de más ni de menos por error. Solo funciona sobre un pedido ya confirmado (confirm_quote) -- si el cliente todavía tiene una cotización sin confirmar, confirmala primero. Si el pedido ya está pagado por completo, la herramienta lo rechaza. NO la llames por defecto después de confirm_quote -- esa herramienta ya genera el link sola cuando corresponde. Usala únicamente cuando confirm_quote te haya devuelto `payment_options` (más de una forma de cobro disponible) y el cliente, al preguntarle, haya elegido pagar con Wompi.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "charge_sale_to_credit",
    skill: "credito",
    description:
      "Carga el saldo pendiente exacto del pedido confirmado más reciente del cliente a su cuenta de crédito (fiado), en vez de cobrarlo ahora. Sin parámetros -- el monto NUNCA lo elegís vos, es siempre el saldo pendiente real del pedido. Solo funciona si get_client_profile (habilidad de Gestión de clientes) o el contexto de esta conversación ya indicó que este cliente tiene crédito habilitado -- si no lo tiene, la herramienta lo rechaza. Solo funciona sobre un pedido ya confirmado (confirm_quote). NO la llames por defecto después de confirm_quote -- esa herramienta ya carga a crédito sola cuando corresponde. Usala únicamente cuando confirm_quote te haya devuelto `payment_options` (más de una forma de cobro disponible) y el cliente, al preguntarle, haya elegido pagar a crédito.",
    parameters: { type: "object", properties: {}, required: [] },
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
