-- Revierte report_payment (20260809200000/20260809200100): decisión
-- explícita del usuario -- la IA nunca puede tener la habilidad de
-- confirmar/registrar pagos, eso pasa únicamente por una pasarela de pago
-- (cuando se integre) o manualmente desde el portal por un agente humano.
-- La tool y su case en whatsapp-ai-tools/index.ts ya se quitaron en esta
-- misma ronda; created_by_ai en crm_order_payments queda muerta (ningún
-- código puede volver a escribir true ahí), se elimina.
alter table public.crm_order_payments drop column created_by_ai;
