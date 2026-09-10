-- Configuración de impresión de tickets POS -- por tenant, no por punto de
-- venta (mismo alcance que pos_allow_open_tabs): un negocio real casi
-- siempre imprime con el mismo tipo de impresora/papel en todos sus
-- puntos, y no había ningún caso de uso concreto que pidiera una impresora
-- distinta por mesa/caja. Se puede abrir eso a futuro sin romper nada
-- (agregar una columna nullable a pos_points que sobrescriba el default del
-- tenant), no se construye ahora sin necesidad real.
alter table public.tenants
  add column pos_receipt_paper_width text not null default '80mm'
    check (pos_receipt_paper_width in ('58mm', '80mm')),
  add column pos_auto_print boolean not null default false,
  add column pos_receipt_footer_message text;

comment on column public.tenants.pos_receipt_paper_width is 'Ancho de papel térmico -- los dos únicos anchos reales del mercado de impresoras POS.';
comment on column public.tenants.pos_auto_print is 'Si true, el ticket se manda a imprimir (diálogo del navegador) apenas se confirma un cobro del POS, sin que el cajero tenga que pedirlo. Limitación de navegador: "automático" abre el diálogo de impresión del sistema, no imprime en silencio -- eso requeriría un agente local aparte, fuera de alcance.';
comment on column public.tenants.pos_receipt_footer_message is 'Texto libre al pie del ticket (ej. "Gracias por su compra"). null = se usa un mensaje genérico por defecto, no un tenant sin footer.';
