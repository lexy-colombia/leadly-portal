# Changelog

Todos los cambios notables de Leadly se documentan en este archivo. Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y [Semantic Versioning](https://semver.org/lang/es/).

> **Nota (2026-09-11)**: este archivo estuvo sin actualizar desde la versión 1.0.0 (2026-08-04) pese a meses de trabajo real -- pivote a ERP, POS, facturación electrónica DIAN, inventario, cartera, devoluciones, etc. Las versiones 1.0.1 a 1.0.4 se reconstruyeron recién hoy a partir del historial real del proyecto ([CLAUDE.md](../CLAUDE.md)), agrupado en versiones que nunca se etiquetaron en su momento -- el contenido es real, los cortes de versión son aproximados. Se retoma el hábito desde acá en más: de ahora en adelante, cada commit actualiza este archivo.

## [1.0.8] - 2026-09-11

### Added
- Pago dividido también en el drawer de pagos (cuentas abiertas y "Agregar pago" de un pedido), reusando el mismo `PaymentLinesEditor` de la venta rápida -- antes solo estaba en Venta Rápida.
- Al agregar otra línea de pago, el monto arranca solo con lo que queda por asignar (en vez de vacío), y cambiar de método o tipear un monto se recorta en el momento para nunca superar el saldo pendiente (o el saldo a favor disponible, si el método es ese) -- mismo candado que tenía el campo único antes de poder dividir el pago.

### Fixed
- Registrar un pago en efectivo sin escribir "Recibido" no guardaba nada (ese campo siempre fue opcional, una validación de más lo empezó a bloquear en silencio al agregar el pago dividido al drawer).
- Eliminar un pago de un pedido ya confirmado no hacía nada: un trigger de base de datos de antes de que existiera el permiso `sales.edit_invoiced_order` seguía bloqueando cualquier cambio a un pago fuera de cotización, sin enterarse de ese permiso nuevo -- ahora usa el mismo criterio que ya aplicaba la RLS. El error, si lo hay, también se muestra en vez de fallar en silencio.

## [1.0.7] - 2026-09-11

### Added
- Pago dividido en la venta rápida del POS: se puede cargar más de un método de pago (ej. parte en efectivo, parte con tarjeta) antes de cobrar, todo en un solo cobro -- antes había que cobrar todo con un método y, para dividirlo, salir a Ventas a buscar el pedido y agregar el resto ahí.

## [1.0.6] - 2026-09-11

### Added
- Permiso `sales.edit_invoiced_order`: permite corregir el cliente y los pagos de un pedido ya confirmado (tenga o no factura DIAN) -- pedidos despachados o anulados siguen bloqueados siempre, sin excepción.
- Editor para corregir el método de un pago ya registrado (ej. se cargó "efectivo" por error) sin borrarlo y volver a crearlo.

### Fixed
- El editor de método de pago ofrecía "Crédito"/"Saldo a favor" aunque el cliente no tuviera cuenta de crédito ni saldo real.

## [1.0.5] - 2026-09-11

### Added
- Impresión térmica directa por WebUSB (ESC/POS), como alternativa opt-in por tenant a la impresión vía el diálogo del sistema -- resuelve que el ticket se cortara por un tamaño de papel que el driver de la impresora no lograba hacer coincidir. Incluye el logo del negocio (rasterizado a 1 bit) y código QR nativo de la impresora.
- Fecha y hora de apertura de una cuenta, visible en el detalle de cuentas abiertas del POS.

### Changed
- Historial de documentos DIAN (factura/nota crédito) rediseñado: el motivo de rechazo pasó de texto inline a un ícono con detalle al hacer clic, y las acciones (correo, nota crédito, reenviar, descargar PDF) pasaron a íconos con tooltip agrupados a la derecha, en vez de botones de texto que se desbordaban en pantallas angostas.

### Fixed
- Desborde de contenido en el detalle de un pedido en pantallas de 14" o menos.
- El selector de tipo de impuesto de un producto mostraba dos opciones casi idénticas ("Impuesto al Consumo genérico" e "INC") -- se desactivó la genérica, que ningún producto usaba realmente.
- Montos del ticket térmico mostraban "$?19.000" en vez de "$19.000" (un carácter de espacio sin mapear en la codificación de caracteres de la impresora).

## [1.0.4] - 2026-09-06

### Added
- Roles y permisos configurables por tenant: cada negocio puede crear sus propios roles y asignarles permisos por acción dentro de cada módulo, en vez de un único rol de agente con acceso total.
- Módulo de Gastos, con categorías y entrada de inventario directa desde un gasto.
- Agendamiento real de citas (duración, vínculo a una oportunidad).

### Changed
- Calendario y Dashboard rediseñados alrededor de datos reales, con un esquema de color más simple (antes 7 colores sin leyenda).
- Rebrand visual a Lexy.

## [1.0.3] - 2026-09-04

### Added
- Módulo de punto de venta (POS): venta rápida, cuentas abiertas, puntos de venta e impresión de tickets térmicos.
- Facturación electrónica DIAN: impuestos por producto, firma del documento (UBL 2.1 + XAdES-EPES), envío por SOAP/mTLS, representación en PDF.

### Fixed
- El stock no se devolvía al anular una venta ya confirmada.
- Listados grandes de pedidos se cortaban en 1000 filas -- paginación real del lado del servidor.

## [1.0.2] - 2026-08-26

### Added
- Cobro por WhatsApp con Wompi y crédito de clientes, con generación del link de pago desde el asistente de IA.
- Tienda pública por tenant (catálogo, carrito, checkout con verificación por código y pago con Wompi o crédito).

### Fixed
- La confirmación de pago de Wompi rechazaba siempre por comparar contra el secreto equivocado.

## [1.0.1] - 2026-08-15

### Added
- Esquema de datos del ERP (clientes, productos, oportunidades, pedidos, tareas), reemplazando gradualmente el esquema original del CRM.
- Inventario multi-bodega con kardex de movimientos de stock.

## [1.0.0] - 2026-08-04

### Added
- Fundación del proyecto: multi-tenancy (`tenants`/`profiles`), autenticación (email/password + Google OAuth), layouts de Backoffice y Panel del cliente con guards de ruta por rol.
- Esquema base de WhatsApp/IA: líneas de WhatsApp, catálogo de modelos de IA (OpenAI/Gemini), configuración de asistente por línea, conversaciones y ledger de mensajes.

## [0.1.0] - 2026-08-02
### Added
- Arranque del proyecto Leadly.
