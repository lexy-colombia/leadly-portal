-- book_appointment gana duration_minutes (opcional) y vincula la cita a la
-- oportunidad abierta del contacto automáticamente -- pedido explícito del
-- usuario, en la misma ronda en que se centralizó la lógica de citas en
-- _shared/appointments/manageAppointment.ts (portal + IA comparten el mismo
-- código real ahora, ver manage-appointment/index.ts y
-- whatsapp-ai-tools/index.ts). El vínculo a la oportunidad no necesita
-- ningún parámetro nuevo del lado del modelo -- se resuelve solo del lado
-- del servidor, mismo criterio que ya usan create_opportunity/
-- get_opportunity_status (el modelo nunca ve ni maneja un id de oportunidad).

update ai_skills
set prompt_fragment = prompt_fragment || '

book_appointment ahora también acepta duration_minutes (opcional, entero, en minutos) -- pasalo solo si el cliente mencionó cuánto va a durar la cita (ej. "necesito una hora" -> 60, "algo rápido, 15 minutos" -> 15). Nunca le preguntes la duración si no la mencionó primero -- sin este dato, la cita queda de 30 minutos por defecto.

Cada cita queda vinculada automáticamente a la oportunidad abierta del cliente, si tiene una -- esto es enteramente automático del lado del servidor, no hace falta que hagas ni menciones nada al respecto.'
where key = 'calendario';
