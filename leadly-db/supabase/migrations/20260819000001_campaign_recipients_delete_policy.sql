-- Habilita reemplazar los destinatarios de una campaña todavía no
-- disparada (editar/duplicar desde el panel del tenant, ver
-- CampaignFormDrawer) -- la migración original de campaigns
-- (20260818220001) solo otorgó select/insert sobre campaign_recipients,
-- pensando en un flujo de "crear y listo". Editar antes de que
-- run-campaigns tome la campaña (status 'scheduled', lo que garantiza
-- sent_count = 0 en todas sus filas) necesita poder borrar los
-- destinatarios viejos para reemplazarlos por los nuevos -- más simple y
-- seguro que diffear fila por fila.
create policy campaign_recipients_delete on public.campaign_recipients
  for delete using (
    (tenant_id = public.auth_active_tenant_id() and exists (
      select 1 from public.campaigns c
      where c.id = campaign_recipients.campaign_id and c.status = 'scheduled'
    ))
    or public.is_superadmin()
  );

grant delete on public.campaign_recipients to authenticated;
