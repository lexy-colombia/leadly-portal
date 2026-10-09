# Dashboard operativo y CRM

Implementación del 8 de octubre de 2026.

## Vistas

**Resumen:** ventas confirmadas, pedidos por entregar, despachos, cartera actual, productos más vendidos, evolución de ventas, canales de venta, actividad reciente, pendientes operativos e inventario bajo.

**Atención:** conversaciones de WhatsApp, tiempo de respuesta, oportunidades por etapa, tareas y rendimiento del equipo. Esta vista está disponible con cualquiera de sus módulos habilitados; no requiere WhatsApp si la empresa solo tiene pipeline o calendario. El equipo solo aparece para administradores con acceso a calendario.

Las consultas se activan únicamente para la vista y los módulos autorizados. No se alteran tablas, políticas RLS, permisos de usuarios ni planes.

## Definiciones

- Ventas: órdenes confirmadas por fecha de creación, dentro de un rango de días locales con extremo final exclusivo. Comparación con el periodo inmediatamente anterior del mismo tamaño. Sin base anterior, no se inventa un crecimiento porcentual.
- Pedidos por entregar: todas las órdenes confirmadas cuyo estado de entrega no sea entregado. Incluye pendientes antiguos; no depende del periodo del gráfico.
- Despachos: registros creados dentro del periodo, no entregas realizadas.
- Cartera: cargos menos abonos no eliminados, sobre clientes con crédito habilitado, igual al criterio del módulo existente. Saldo actual fuera del filtro de fechas.
- Productos y canales: reutilizan reports-summary; requieren módulo Reportes y reports.view. El canal representa el valor vendido, no atribución a IA ni procedencia de contactos.
- Conversaciones: última actividad dentro del periodo seleccionado, no número de mensajes ni conversaciones nuevas.
- Respuesta: promedio del tiempo entre un mensaje entrante y el siguiente saliente en esa conversación. Excluye pausas mayores de 24 horas. Se consulta una ventana previa de 24 horas para poder emparejar respuestas en el límite inicial del periodo. Menos de un minuto se indica explícitamente; sin pares se muestra un guion.
- Rendimiento: usuarios del equipo; no métricas de agentes de IA. Tareas próximas y vencidas separadas; cumplimiento calculado solo sobre tareas completadas.

## Fuentes y límites

Los getters de dashboardOverview consultan filas ligeras, filtradas por tenant y paginadas por id. Cartera, órdenes, despachos, conversaciones y mensajes no se truncarán al llegar a 1000 registros. Mensajes se limitan al rango necesario y a grupos de 50 conversaciones, con pertenencia al tenant a través de su conversación.

Inventario reutiliza el filtro lowStockOnly de productos; sus restricciones existentes no se rediseñaron. Tareas, devoluciones y pipeline reutilizan sus APIs actuales. Agregaciones financieras y de productos permanecen en servidor. Los errores se presentan en la tarjeta, con opción de reintentar, y no se convierten en totales cero.

## Validación

- npm run build
- npm run test:dashboard: 13 pruebas de fechas, estados, acceso por módulos/permisos y paginación.
- Oxlint sobre los archivos modificados, sin diagnósticos.
- Verificación con sesión real: filtros de 7/30 días, cartera invariable, pendientes antiguos, Resumen sin CRM y Atención con los bloques de CRM.
- Responsive comprobado en 390, 768 y 1440 px; sin desbordamiento horizontal.

Las pruebas TypeScript ejecutadas directamente con Node requieren un runtime que soporte --experimental-strip-types; se verificaron en el runtime local del proyecto.
