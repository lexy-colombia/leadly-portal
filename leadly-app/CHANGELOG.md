# Changelog

Todos los cambios notables de Leadly se documentan en este archivo. Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y [Semantic Versioning](https://semver.org/lang/es/).

> **Nota (2026-09-11)**: este archivo estuvo sin actualizar desde la versión 1.0.0 (2026-08-04) pese a meses de trabajo real -- pivote a ERP, POS, facturación electrónica DIAN, inventario, cartera, devoluciones, etc. Las versiones 1.0.1 a 1.0.4 se reconstruyeron recién hoy a partir del historial real del proyecto ([CLAUDE.md](../CLAUDE.md)), agrupado en versiones que nunca se etiquetaron en su momento -- el contenido es real, los cortes de versión son aproximados. Se retoma el hábito desde acá en más: de ahora en adelante, cada commit actualiza este archivo.

## [1.0.14] - 2026-09-13

### Added
- Consecutivo por comercio para los egresos (EGR-1, EGR-2...), asignado al crear el gasto, con los 6.092 existentes numerados por fecha y visible como columna en la lista. Un comprobante impreso sin número no se puede referenciar después.
- Impresión del comprobante de egreso: tirilla térmica (mismo mecanismo que el ticket del POS: WebUSB directo si el comercio lo tiene activado, si no el diálogo del sistema) y PDF tamaño carta, con el mismo diseño de la factura -- sin QR ni CUFE, y con bloque de firmas en su lugar, porque un egreso es un documento interno de control, no fiscal.
- Cartera: los abonos se pueden imprimir como soporte de pago en tirilla térmica (número de recibo, cliente, método, monto y saldo actual).

### Changed
- Cartera: en un cargo, el número de pedido de la nota ("Cargo por orden #28258") es ahora el enlace que abre ese pedido.

### Fixed
- Gastos: el más reciente arriba. La lista ordenaba solo por fecha del gasto, que es una fecha sin hora, así que el orden dentro de un mismo día lo decidía la base (en la práctica, el más viejo primero).

## [1.0.13] - 2026-09-13

### Added
- Los filtros, la búsqueda y la página de las listas quedan en la URL (`?status=&from=&page=...`), así que entrar al detalle de una fila y volver con "atrás" ya no los pierde, y el enlace se puede guardar o compartir con la vista ya filtrada. Aplica a Órdenes, Productos, Clientes y Gastos. Lo que está en su valor por defecto no se escribe, y el historial se reemplaza en vez de apilarse (el botón "atrás" no deshace letra por letra lo tipeado en el buscador).

### Fixed
- Barriles de la sexta: las ventas de septiembre que quedaron sin ningún pago cargado ahora tienen su pago en efectivo registrado (29 pedidos, $1.212.000, todos del 5 de septiembre), con la fecha del pago igual al día de la venta. Se excluyeron los pedidos en $0, los de pago parcial y los anulados.

## [1.0.12] - 2026-09-13

### Changed
- Gastos: al dar entrada de inventario desde un gasto ahora se informa el **costo total** de la línea (lo que dice la factura del proveedor) y el sistema calcula el unitario, en vez de obligar a dividir a mano. El unitario se muestra como referencia debajo del campo.
- Un solo componente de selector en toda la app: se eliminaron el `<select>` nativo de `atoms` y el `IconSelect` de `molecules` (este último no se usaba en ningún lado), y se migraron a shadcn los 5 selectores que quedaban (Dashboard y las dos pantallas de Líneas de WhatsApp del backoffice).

### Fixed
- El tipo de impuesto de un producto no se podía cambiar y se borraba solo al guardar: el selector vive dentro de un formulario, así que la librería mantiene un `<select>` nativo oculto; montado con un valor que todavía no existe como opción (el catálogo llega por consulta), el navegador lo dejaba vacío y ese vacío pisaba el valor real. Corregido en el componente `Select` compartido, así que cubre las ~17 pantallas con ese mismo patrón.
- Ficha de producto: el selector de impuesto no se dibuja hasta tener el catálogo cargado, si el catálogo falla ahora se ve el error con "Reintentar" (antes se ignoraba en silencio), y un producto sin tipo de impuesto ya no arranca en IVA por defecto.

## [1.0.11] - 2026-09-12

### Fixed
- La DIAN rechazaba algunas facturas con "Valor del CUFE no está calculado correctamente" (FAD06), siempre las mismas en cada reintento: el CUFE truncaba sumas con error de coma flotante (ej. 74074.06999… en vez de 74074.07) y quedaba un centavo distinto del valor impreso en el XML. Dependía de los montos y el orden de las líneas, por eso unas facturas pasaban y otras no. Afecta también el CUDE de notas crédito.
- Un pedido confirmado podía quedar sin productos y en $0 (con su pago y el inventario ya descontados): el autoguardado del detalle del pedido reescribía los ítems en bucle y, en una carrera con su propia recarga, llegó a guardar la lista vacía. Ahora una venta confirmada no acepta cambios de productos/precios/envío desde el servidor, y el detalle solo autoguarda el cliente en ese caso.

## [1.0.10] - 2026-09-12

### Fixed
- Las fechas sin hora (fecha de un pago, emisión de factura DIAN, fecha de un gasto, vencimientos) se mostraban un día antes en toda la app: se interpretaban como medianoche UTC, que en Colombia cae el día anterior. Solo afectaba lo que se veía en pantalla, los datos guardados estaban bien.

## [1.0.9] - 2026-09-12

### Added
- El resumen de Órdenes suma las cuentas abiertas del POS todavía sin cobrar: tarjeta nueva "Cuentas abiertas", "Total digitado" (pedidos + cuentas abiertas) y "Pendiente por cobrar" incluyéndolas, más su fila en el desglose por método de pago -- antes solo contaba lo ya cobrado, así que con mesas abiertas el comercio veía menos ventas de las reales y $0 por cobrar.
- La lista de Órdenes muestra el nombre del punto de venta (ej. "Mesa 16") debajo del número de orden, en vez del genérico "Punto de venta"; el detalle del pedido lo muestra como "Punto de venta: Mesa 16".

### Removed
- Bloque "Mesas con más ventas" del resumen de Órdenes.

### Fixed
- El filtro de fechas de Órdenes interpretaba el día en UTC en vez de hora de Colombia: "hoy" iba de las 7 p. m. de ayer a las 7 p. m. de hoy, así que las ventas de la noche caían en el día siguiente.

## [1.0.8] - 2026-09-11

### Added
- Pago dividido también en el drawer de pagos (cuentas abiertas y "Agregar pago" de un pedido), reusando el mismo `PaymentLinesEditor` de la venta rápida -- antes solo estaba en Venta Rápida.
- Al agregar otra línea de pago, el monto arranca solo con lo que queda por asignar (en vez de vacío), y cambiar de método o tipear un monto se recorta en el momento para nunca superar el saldo pendiente (o el saldo a favor disponible, si el método es ese) -- mismo candado que tenía el campo único antes de poder dividir el pago.
- Checkbox de "generar factura electrónica" al cobrar en la venta rápida del POS (para tenants con DIAN conectada), igual que ya existía en cuentas abiertas -- sin esto, una venta de venta rápida solo reservaba la factura como pendiente y había que ir después al detalle del pedido para poder emitirla.

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
