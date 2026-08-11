-- Confirming a cotización as a real venta is an unambiguous "won" signal for
-- its linked oportunidad (crm_orders.opportunity_id) -- this used to only
-- happen when the WhatsApp AI called confirm_quote (moveLinkedOpportunityToWon
-- in whatsapp-ai-tools/index.ts), so a human agent confirming a sale by hand
-- from Ventas.tsx (updateOrderStatus -> plain status update, no opportunity
-- side effect) left the pipeline stale. Centralizing this as a DB trigger
-- (same reasoning as trg_crm_orders_status_stock right above this file,
-- and crm_opportunities_log_stage_change) means both callers -- and any
-- future one -- can never drift out of sync again. The Deno-side
-- moveLinkedOpportunityToWon is removed in the same round (whatsapp-ai-tools),
-- this trigger is now the single source of truth.
--
-- The opportunity update below also fires the existing
-- crm_opportunities_log_stage_change trigger (20260806000008), so the stage
-- history / "tiempo promedio" metrics pick this up for free.
create or replace function public.apply_order_confirmed_opportunity_effect()
returns trigger
language plpgsql
as $$
declare
  v_pipeline_id uuid;
  v_won_stage_id uuid;
begin
  if new.opportunity_id is null then
    return new;
  end if;

  select pipeline_id into v_pipeline_id from public.crm_opportunities where id = new.opportunity_id;
  if v_pipeline_id is null then
    return new;
  end if;

  select id into v_won_stage_id
  from public.crm_pipeline_stages
  where pipeline_id = v_pipeline_id and is_won = true
  order by display_order asc
  limit 1;
  if v_won_stage_id is null then
    return new;
  end if;

  update public.crm_opportunities
  set stage_id = v_won_stage_id, status = 'won'
  where id = new.opportunity_id;

  return new;
end;
$$;

create trigger trg_crm_orders_confirmed_opportunity after update of status on public.crm_orders
  for each row when (old.status is distinct from new.status and new.status = 'confirmada')
  execute function public.apply_order_confirmed_opportunity_effect();
