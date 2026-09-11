# Changelog

Todos los cambios notables de Leadly se documentan en este archivo. Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/) y [Semantic Versioning](https://semver.org/lang/es/).

> **Nota (2026-09-11)**: este archivo estuvo sin actualizar desde la versión 1.0.0 (2026-08-04) pese a meses de trabajo real -- pivote a ERP, POS, facturación electrónica DIAN, inventario, cartera, devoluciones, etc. (ver [CLAUDE.md](../CLAUDE.md) para ese historial completo). Se retoma desde acá en más: de ahora en adelante, cada commit actualiza este archivo.

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

## [1.0.0] - 2026-08-04

### Added
- Fundación del proyecto: multi-tenancy (`tenants`/`profiles`), autenticación (email/password + Google OAuth), layouts de Backoffice y Panel del cliente con guards de ruta por rol.
- Esquema base de WhatsApp/IA: líneas de WhatsApp, catálogo de modelos de IA (OpenAI/Gemini), configuración de asistente por línea, conversaciones y ledger de mensajes.

## [0.1.0] - 2026-08-02
### Added
- Arranque del proyecto Leadly.
