-- Pedido explícito del usuario (2026-09-06): borrar todo el calendario del
-- tenant de pruebas TecnoNova Colombia (antes "Tenant QA Uno") y poblarlo con
-- actividad realista del 1 al 15 de septiembre de 2026 -- citas, tareas y
-- oportunidades acordes a lo que vende (accesorios de tecnología: audífonos,
-- cargadores, controles de consola, cámaras de seguridad, domótica) -- para
-- que la cuenta funcione como una demo creíble, no datos de humo.
--
-- Se conservan las 12 oportunidades preexistentes (todas de pruebas previas
-- de IA/storefront, la mayoría "Ganado") -- el pedido fue limpiar el
-- calendario (citas/tareas), no el pipeline. Se agregan 12 oportunidades
-- nuevas repartidas en las 6 etapas de "Ventas" para que las citas/tareas
-- nuevas tengan con qué vincularse de forma realista.
--
-- Hallazgo real al ejecutar esto: insertar en `opportunities` dispara el
-- trigger `opportunities_create_followup_task` (ya existía, no es nuevo) que
-- crea automáticamente una tarea "Dar seguimiento: <título>" por cada una --
-- las 12 quedaron con el mismo `due_date` al segundo (calculado desde el
-- `now()` real de cuando corrió esta migración, no desde las fechas
-- ficticias de septiembre) y sin `reminder_sent_at`, lo cual además de verse
-- robótico en el calendario dejaba esas filas expuestas al cron real
-- `send-task-reminders`. Se borraron esas 12 (identificables por
-- `reminder_sent_at is null`, ya que las 20 tareas curadas de abajo siempre
-- lo traen seteado) después de aplicar esta migración -- no se repite ese
-- delete acá porque ya se resolvió a mano contra la base real.
--
-- Medida de seguridad deliberada: TODAS las citas y tareas de acá abajo
-- traen `reminder_sent_at` ya seteado (no null), sin importar que su
-- `status`/fecha caigan dentro de la ventana real de los crons
-- `send-appointment-reminders`/`send-task-reminders` -- son datos sintéticos
-- de demo, nunca deben disparar un WhatsApp real a ninguno de estos
-- números (varios son de prueba, pero un par son teléfonos reales
-- reutilizados de rondas de testing anteriores).

do $$
declare
  v_tenant uuid := 'cb195047-8cd2-4e38-9964-62bb99911814'; -- TecnoNova Colombia
  v_admin uuid := '960a6baf-fcaf-4c6a-aeaa-daeb2d50d40d'; -- QA Admin Uno
  v_agent uuid := '60b5f463-dadb-485b-a07f-6fa0b3b67e07'; -- sebastian
  v_pipeline uuid := 'fd693b1c-e62a-48d1-bbd9-dcdfa1869752'; -- pipeline "Ventas"
  v_st_nuevo uuid := '88e2828c-06a6-4092-82c7-ed3f19bac701';
  v_st_contactado uuid := 'c7df1744-e290-441f-b062-f1ecd53d21eb';
  v_st_propuesta uuid := 'f20277eb-26cf-4ff0-9647-34877b5f7acc';
  v_st_negociacion uuid := 'e65d5758-1d3c-474f-987c-af328150a2c8';
  v_st_ganado uuid := 'eea3dca2-a509-4b57-b0b4-17f31598ec90';
  v_st_perdido uuid := '09b4a76e-dc79-4429-9682-96aaa456f4bd';

  c_andres uuid := 'e35f15ee-9752-421c-966e-c7af9777936d';
  c_jorge uuid := '1ef080ad-01a0-4535-9f8e-2a1d8e5f24ca';
  c_monica uuid := '44eecf4b-4f73-452a-a527-6c78b55bfd64';
  c_diana_m uuid := 'dba69ebe-562b-4681-849f-e52a4edb08bc';
  c_camilo uuid := 'fc37ce25-8761-4ad1-a749-a537f8697e1a';
  c_rosa uuid := 'aadce967-5d39-452d-ae08-33d29e5acaca';
  c_juanp uuid := 'e9c4127b-386d-464e-b3c6-96e144e13849';
  c_julian uuid := '2a1d36d4-8d1b-41ac-bca4-e9eea1a461e1';
  c_valentina uuid := 'b2df6905-b743-4784-b66b-9f950c271aa0';
  c_felipe uuid := '3cf73396-fb71-49c4-9d6e-b6f12eaa6d05';
  c_carlos uuid := '42b2801b-da13-420d-b3a3-69cecb1e655f';
  c_sergio uuid := 'a804fc16-2413-4801-bc32-0be0f4e067aa';
  c_manuela uuid := '07f73b57-f1f8-4511-89d7-cee1205c2289';
  c_diana_a uuid := 'c880fb6d-ce08-401c-ae34-cef89712b97f';
  c_edgar uuid := 'ad4ffcf6-f648-4d7a-ba3e-4891177db857';
  c_katherine uuid := 'bab60d21-2328-4d5d-914a-ee8b33a3b0d2';
  c_oscar uuid := 'aab95aa2-4a99-47d3-a241-2fb477df5f5d';
  c_santiago uuid := 'b84df78d-841a-41e4-af43-b7e0de78c09a';
  c_natalia uuid := '5835c9ab-875f-44aa-8181-58bfe183ab39';
  c_laura uuid := 'b0740fb7-e853-4de8-8f10-e11a5c20943b';
  c_karol uuid := '21ec560c-5ecb-47a7-8cce-0b7066db4017';
  c_camila uuid := 'bf15b50e-78c3-4aee-bfef-9d587e55de32';
  c_camila_existing_opp uuid := '0961227b-dd2a-4a5f-a8fa-aa165a342fa7'; -- oportunidad preexistente de Camila (Propuesta)

  o1 uuid := gen_random_uuid();
  o2 uuid := gen_random_uuid();
  o3 uuid := gen_random_uuid();
  o4 uuid := gen_random_uuid();
  o5 uuid := gen_random_uuid();
  o6 uuid := gen_random_uuid();
  o7 uuid := gen_random_uuid();
  o8 uuid := gen_random_uuid();
  o9 uuid := gen_random_uuid();
  o10 uuid := gen_random_uuid();
  o11 uuid := gen_random_uuid();
  o12 uuid := gen_random_uuid();
begin
  delete from appointments where tenant_id = v_tenant;
  delete from tasks where tenant_id = v_tenant;

  insert into opportunities (id, tenant_id, pipeline_id, stage_id, contact_id, owner_id, title, value, currency, priority, expected_close_date, status, created_at, updated_at) values
    (o1, v_tenant, v_pipeline, v_st_nuevo, c_edgar, v_admin, 'Interesado en Cámara de Seguridad WiFi 360°', 212000, 'COP', 'media', '2026-09-20', 'open', '2026-09-01 10:00:00-05', '2026-09-01 10:00:00-05'),
    (o2, v_tenant, v_pipeline, v_st_nuevo, c_diana_a, v_agent, 'Cotización de Cargador Inalámbrico 3 en 1', 216000, 'COP', 'baja', '2026-09-22', 'open', '2026-09-01 15:00:00-05', '2026-09-01 15:00:00-05'),
    (o3, v_tenant, v_pipeline, v_st_nuevo, c_santiago, v_admin, 'Consulta por Control Inalámbrico PS5 DualStrike', 212000, 'COP', 'media', '2026-09-23', 'open', '2026-09-02 09:30:00-05', '2026-09-02 09:30:00-05'),
    (o4, v_tenant, v_pipeline, v_st_contactado, c_sergio, v_agent, 'Seguimiento cámara de seguridad exterior solar', 383000, 'COP', 'media', '2026-09-18', 'open', '2026-09-02 14:00:00-05', '2026-09-02 14:00:00-05'),
    (o5, v_tenant, v_pipeline, v_st_contactado, c_manuela, v_admin, 'Cotización cargadores USB-C 65W para oficina', 428000, 'COP', 'alta', '2026-09-19', 'open', '2026-09-03 11:00:00-05', '2026-09-03 11:00:00-05'),
    (o6, v_tenant, v_pipeline, v_st_propuesta, c_katherine, v_agent, 'Propuesta audífonos gamer BattleSound 7.1', 216000, 'COP', 'media', '2026-09-17', 'open', '2026-09-04 09:00:00-05', '2026-09-04 09:00:00-05'),
    (o7, v_tenant, v_pipeline, v_st_propuesta, c_oscar, v_admin, 'Propuesta kit oficina: base para laptop + cooling pad', 180000, 'COP', 'baja', '2026-09-16', 'open', '2026-09-05 10:00:00-05', '2026-09-05 10:00:00-05'),
    (o8, v_tenant, v_pipeline, v_st_negociacion, c_carlos, v_agent, 'Negociación control Xbox Series + audífonos gamer', 430000, 'COP', 'alta', '2026-09-16', 'open', '2026-09-05 16:00:00-05', '2026-09-05 16:00:00-05'),
    (o9, v_tenant, v_pipeline, v_st_negociacion, c_felipe, v_admin, 'Negociación cámaras de seguridad x2 para local', 766000, 'COP', 'alta', '2026-09-17', 'open', '2026-09-06 10:00:00-05', '2026-09-06 10:00:00-05'),
    (o10, v_tenant, v_pipeline, v_st_ganado, c_julian, v_admin, 'Venta control PS5 DualStrike', 212000, 'COP', 'media', '2026-09-09', 'won', '2026-09-04 08:00:00-05', '2026-09-09 09:30:00-05'),
    (o11, v_tenant, v_pipeline, v_st_ganado, c_natalia, v_agent, 'Venta bombilla y enchufe inteligente', 175000, 'COP', 'baja', '2026-09-09', 'won', '2026-09-05 08:00:00-05', '2026-09-09 14:00:00-05'),
    (o12, v_tenant, v_pipeline, v_st_perdido, c_camilo, v_agent, 'Cámara de seguridad solar -- cliente prefirió otra marca', 383000, 'COP', 'media', '2026-09-12', 'lost', '2026-09-03 08:00:00-05', '2026-09-12 09:00:00-05');

  insert into appointments (tenant_id, contact_id, scheduled_at, ends_at, notes, status, created_by, assigned_to, opportunity_id, reminder_sent_at) values
    (v_tenant, c_edgar,     '2026-09-01 10:00:00-05', '2026-09-01 10:30:00-05', 'Mostrar cámara de seguridad WiFi 360° y explicar instalación.', 'completada', v_admin, v_admin, o1, '2026-09-01 09:00:00-05'),
    (v_tenant, c_diana_a,   '2026-09-01 15:00:00-05', '2026-09-01 15:20:00-05', 'Confirmar cotización de cargador inalámbrico 3 en 1.', 'completada', v_agent, v_agent, o2, '2026-09-01 14:00:00-05'),
    (v_tenant, c_santiago,  '2026-09-02 09:30:00-05', '2026-09-02 10:00:00-05', 'Demostración de control PS5 DualStrike.', 'completada', v_admin, v_admin, o3, '2026-09-02 08:30:00-05'),
    (v_tenant, c_sergio,    '2026-09-02 14:00:00-05', '2026-09-02 14:45:00-05', 'Visita para revisar instalación de cámara exterior.', 'completada', v_agent, v_agent, o4, '2026-09-02 13:00:00-05'),
    (v_tenant, c_manuela,   '2026-09-03 11:00:00-05', '2026-09-03 11:30:00-05', 'Revisar necesidad de cargadores para la oficina.', 'completada', v_admin, v_admin, o5, '2026-09-03 10:00:00-05'),
    (v_tenant, c_rosa,      '2026-09-03 16:00:00-05', '2026-09-03 16:20:00-05', 'Entrega de audífonos ProBeat X1.', 'completada', v_agent, v_agent, null, '2026-09-03 15:00:00-05'),
    (v_tenant, c_jorge,     '2026-09-04 09:00:00-05', '2026-09-04 09:30:00-05', 'Reunión de seguimiento post-venta.', 'completada', v_admin, v_admin, null, '2026-09-04 08:00:00-05'),
    (v_tenant, c_valentina, '2026-09-04 13:30:00-05', '2026-09-04 14:00:00-05', 'Cita de asesoría en accesorios gaming.', 'completada', v_agent, v_agent, null, '2026-09-04 12:30:00-05'),
    (v_tenant, c_laura,     '2026-09-04 14:15:00-05', '2026-09-04 14:45:00-05', 'Consulta de garantía de producto.', 'activa', v_admin, v_admin, null, '2026-09-04 13:15:00-05'),
    (v_tenant, c_andres,    '2026-09-04 15:15:00-05', '2026-09-04 15:45:00-05', 'Seguimiento de cambio de producto.', 'cancelada', v_agent, v_agent, null, '2026-09-04 14:15:00-05'),
    (v_tenant, c_karol,     '2026-09-05 10:00:00-05', '2026-09-05 10:30:00-05', 'Nueva consulta sobre productos disponibles.', 'completada', v_admin, v_admin, null, '2026-09-05 09:00:00-05'),
    (v_tenant, c_camila,    '2026-09-05 14:00:00-05', '2026-09-05 14:30:00-05', 'Seguimiento de cotización abierta.', 'completada', v_agent, v_agent, c_camila_existing_opp, '2026-09-05 13:00:00-05'),
    (v_tenant, c_katherine, '2026-09-07 09:00:00-05', '2026-09-07 09:45:00-05', 'Presentación de audífonos gamer BattleSound 7.1.', 'activa', v_agent, v_agent, o6, '2026-09-07 08:00:00-05'),
    (v_tenant, c_oscar,     '2026-09-07 11:00:00-05', '2026-09-07 11:30:00-05', 'Revisar kit de accesorios para laptop.', 'activa', v_admin, v_admin, o7, '2026-09-07 10:00:00-05'),
    (v_tenant, c_carlos,    '2026-09-08 10:00:00-05', '2026-09-08 10:30:00-05', 'Negociación de precio: control + audífonos.', 'activa', v_agent, v_agent, o8, '2026-09-08 09:00:00-05'),
    (v_tenant, c_felipe,    '2026-09-08 15:00:00-05', '2026-09-08 15:30:00-05', 'Visita técnica para instalación de cámaras.', 'activa', v_admin, v_admin, o9, '2026-09-08 14:00:00-05'),
    (v_tenant, c_julian,    '2026-09-09 09:30:00-05', '2026-09-09 10:00:00-05', 'Entrega y pago de control PS5 DualStrike.', 'activa', v_admin, v_admin, o10, '2026-09-09 08:30:00-05'),
    (v_tenant, c_natalia,   '2026-09-09 14:00:00-05', '2026-09-09 14:20:00-05', 'Entrega de bombilla y enchufe inteligente.', 'activa', v_agent, v_agent, o11, '2026-09-09 13:00:00-05'),
    (v_tenant, c_diana_m,   '2026-09-10 11:00:00-05', '2026-09-10 11:30:00-05', 'Asesoría de compra de accesorios de audio.', 'activa', v_admin, v_admin, null, '2026-09-10 10:00:00-05'),
    (v_tenant, c_juanp,     '2026-09-10 16:00:00-05', '2026-09-10 16:30:00-05', 'Consulta sobre power banks disponibles.', 'activa', v_agent, v_agent, null, '2026-09-10 15:00:00-05'),
    (v_tenant, c_monica,    '2026-09-11 10:00:00-05', '2026-09-11 10:30:00-05', 'Seguimiento post-venta.', 'activa', v_admin, v_admin, null, '2026-09-11 09:00:00-05'),
    (v_tenant, c_camilo,    '2026-09-12 09:00:00-05', '2026-09-12 09:30:00-05', 'Explicar motivo por el que se descartó la cámara solar.', 'activa', v_agent, v_agent, o12, '2026-09-12 08:00:00-05'),
    (v_tenant, c_rosa,      '2026-09-14 10:00:00-05', '2026-09-14 10:45:00-05', 'Revisión de nuevo pedido.', 'activa', v_admin, v_admin, null, '2026-09-14 09:00:00-05'),
    (v_tenant, c_andres,    '2026-09-15 11:00:00-05', '2026-09-15 11:30:00-05', 'Cierre de seguimiento.', 'activa', v_agent, v_agent, null, '2026-09-15 10:00:00-05');

  insert into tasks (tenant_id, contact_id, opportunity_id, assigned_to, title, description, priority, status, due_date, completed_at, completed_by, reminder_sent_at) values
    (v_tenant, c_edgar,     o1,   v_admin, 'Enviar cotización de cámara WiFi 360°', 'Cotización formal con precio y garantía.', 'media', 'completada', '2026-09-01 12:00:00-05', '2026-09-01 11:50:00-05', v_admin, '2026-09-01 11:00:00-05'),
    (v_tenant, c_manuela,   o5,   v_agent, 'Confirmar stock de cargadores para oficina', null, 'media', 'completada', '2026-09-02 12:00:00-05', '2026-09-02 11:40:00-05', v_agent, '2026-09-02 11:00:00-05'),
    (v_tenant, c_rosa,      null, v_admin, 'Llamar para confirmar entrega', null, 'baja', 'completada', '2026-09-02 17:00:00-05', '2026-09-02 16:50:00-05', v_admin, '2026-09-02 16:00:00-05'),
    (v_tenant, null,        null, v_agent, 'Actualizar inventario de audífonos gamer', 'Revisar existencias reales vs. sistema.', 'baja', 'completada', '2026-09-03 18:00:00-05', '2026-09-03 17:30:00-05', v_agent, '2026-09-03 17:00:00-05'),
    (v_tenant, c_katherine, o6,   v_admin, 'Preparar propuesta de audífonos gamer', null, 'media', 'completada', '2026-09-04 12:00:00-05', '2026-09-04 11:30:00-05', v_admin, '2026-09-04 11:00:00-05'),
    (v_tenant, c_jorge,     null, v_agent, 'Hacer seguimiento a Jorge Peña', 'Cliente no asignado -- confirmar interés.', 'alta', 'completada', '2026-09-04 10:30:00-05', '2026-09-04 10:15:00-05', v_agent, '2026-09-04 09:30:00-05'),
    (v_tenant, c_laura,     null, v_admin, 'Revisar garantía pendiente', null, 'media', 'en_proceso', '2026-09-04 17:00:00-05', null, null, '2026-09-04 16:00:00-05'),
    (v_tenant, c_karol,     null, v_agent, 'Confirmar pago pendiente', null, 'media', 'completada', '2026-09-05 12:00:00-05', '2026-09-05 11:45:00-05', v_agent, '2026-09-05 11:00:00-05'),
    (v_tenant, c_camila,    c_camila_existing_opp, v_admin, 'Revisar cotización abierta de Camila Dussan', null, 'alta', 'pendiente', '2026-09-05 17:00:00-05', null, null, '2026-09-05 16:00:00-05'),
    (v_tenant, null,        null, v_agent, 'Preparar informe semanal de ventas', null, 'baja', 'pendiente', '2026-09-06 17:00:00-05', null, null, '2026-09-06 16:00:00-05'),
    (v_tenant, c_oscar,     o7,   v_admin, 'Enviar catálogo de accesorios gaming', null, 'media', 'pendiente', '2026-09-07 12:00:00-05', null, null, '2026-09-07 11:00:00-05'),
    (v_tenant, c_felipe,    o9,   v_agent, 'Confirmar visita técnica', null, 'alta', 'pendiente', '2026-09-08 12:00:00-05', null, null, '2026-09-08 11:00:00-05'),
    (v_tenant, c_julian,    o10,  v_admin, 'Coordinar entrega con el cliente', null, 'media', 'pendiente', '2026-09-09 12:00:00-05', null, null, '2026-09-09 11:00:00-05'),
    (v_tenant, c_natalia,   o11,  v_agent, 'Seguimiento post-entrega', null, 'baja', 'pendiente', '2026-09-10 12:00:00-05', null, null, '2026-09-10 11:00:00-05'),
    (v_tenant, null,        null, v_admin, 'Revisar niveles de stock de power banks', null, 'baja', 'pendiente', '2026-09-10 17:00:00-05', null, null, '2026-09-10 16:00:00-05'),
    (v_tenant, c_diana_m,   null, v_agent, 'Llamar para cerrar asesoría', null, 'media', 'pendiente', '2026-09-11 12:00:00-05', null, null, '2026-09-11 11:00:00-05'),
    (v_tenant, c_camilo,    o12,  v_admin, 'Documentar motivo de la oportunidad perdida', null, 'baja', 'pendiente', '2026-09-12 12:00:00-05', null, null, '2026-09-12 11:00:00-05'),
    (v_tenant, null,        null, v_agent, 'Preparar reporte de oportunidades del pipeline', null, 'media', 'pendiente', '2026-09-13 17:00:00-05', null, null, '2026-09-13 16:00:00-05'),
    (v_tenant, c_rosa,      null, v_admin, 'Confirmar cita de la próxima semana', null, 'baja', 'pendiente', '2026-09-14 12:00:00-05', null, null, '2026-09-14 11:00:00-05'),
    (v_tenant, c_andres,    null, v_agent, 'Cierre de seguimiento', null, 'media', 'pendiente', '2026-09-15 12:00:00-05', null, null, '2026-09-15 11:00:00-05');

  -- Limpieza del efecto colateral del trigger `opportunities_create_followup_task`
  -- (ver nota arriba) -- se identifican por ser las únicas sin
  -- `reminder_sent_at`, ya que las 20 tareas de arriba siempre lo traen.
  delete from tasks where tenant_id = v_tenant and reminder_sent_at is null;
end $$;
