-- Follow-up to 20260804000020: a real test conversation showed the AI
-- correctly saying it has no vision, but also incorrectly saying it can't
-- even check whether an attachment exists -- get_pqr_status now returns
-- attachment ids (see whatsapp-ai-tools), and a new send_attachment tool can
-- push that image straight to the customer over WhatsApp (decision:
-- send it automatically rather than always handing off to a human, per the
-- user's explicit choice this session). Appends rather than overwrites,
-- same reasoning as 20260804000020.
do $$
declare
  v_updated integer;
begin
  update public.ai_assistants a
  set system_prompt = a.system_prompt || E'\n\nActualización: get_pqr_status también te dice, junto con el PQR y sus últimos seguimientos, si hay imágenes adjuntas (attachments, con su id) -- por ejemplo un comprobante de reembolso. Si el cliente pide ver, que le compartas, o pregunta si hay una foto o un soporte de su caso, primero llamá a get_pqr_status para revisar esa lista, y si hay algo, usá send_attachment con el attachment_id correspondiente para enviárselo directo por WhatsApp -- ya no hace falta derivarlo a un agente solo para eso. Solo podés enviar adjuntos del caso más reciente del cliente.'
  from public.whatsapp_lines wl
  join public.profiles p on p.tenant_id = wl.tenant_id
  where a.whatsapp_line_id = wl.id
    and p.email = 'qa-uno-admin@example.com';

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'No ai_assistants row matched a whatsapp_line for the tenant of profile qa-uno-admin@example.com -- check the email is correct and that this tenant has a WhatsApp line with an assistant already configured.';
  end if;

  raise notice 'Updated % ai_assistants row(s)', v_updated;
end $$;
