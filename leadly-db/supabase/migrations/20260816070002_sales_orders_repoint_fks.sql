-- Cutover de Contactos + Órdenes, parte 2. `sales_orders` fue modelada en la
-- Fase 3 del pivote ERP apuntando a `opportunities`/`contact_addresses` (las
-- tablas nuevas) -- pero Oportunidades y Direcciones no migran en esta
-- ronda, siguen viviendo en `crm_opportunities`/`crm_contact_addresses`.
-- `contact_id` se deja igual (apunta a `contacts`, que ahora sí está viva
-- gracias al espejo de la migración anterior) -- solo se repuntan las otras
-- tres FKs hacia atrás, mismo criterio ya usado con product_stock/
-- stock_movements en el cutover de Productos.

alter table public.sales_orders
  drop constraint sales_orders_opportunity_id_fkey,
  add constraint sales_orders_opportunity_id_fkey
    foreign key (opportunity_id) references public.crm_opportunities(id) on delete set null;

alter table public.sales_orders
  drop constraint sales_orders_shipping_address_id_fkey,
  add constraint sales_orders_shipping_address_id_fkey
    foreign key (shipping_address_id) references public.crm_contact_addresses(id) on delete set null;

alter table public.sales_orders
  drop constraint sales_orders_billing_address_id_fkey,
  add constraint sales_orders_billing_address_id_fkey
    foreign key (billing_address_id) references public.crm_contact_addresses(id) on delete set null;

-- Reemplaza la lógica de apply_sales_order_confirmed_opportunity_effect()
-- (creada vacía/sin uso en la Fase 3) para que mueva la oportunidad en
-- crm_opportunities/crm_pipeline_stages, no en las tablas nuevas sin usar --
-- es el reemplazo directo de apply_order_confirmed_opportunity_effect()/
-- trg_crm_orders_confirmed_opportunity, que se elimina en la próxima
-- migración junto con crm_orders.
create or replace function public.apply_sales_order_confirmed_opportunity_effect()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pipeline_id uuid;
  v_won_stage_id uuid;
begin
  if new.status = 'confirmada' and old.status is distinct from new.status and new.opportunity_id is not null then
    select pipeline_id into v_pipeline_id from public.crm_opportunities where id = new.opportunity_id;

    if v_pipeline_id is not null then
      select id into v_won_stage_id
        from public.crm_pipeline_stages
        where pipeline_id = v_pipeline_id and is_won = true
        order by display_order asc
        limit 1;

      if v_won_stage_id is not null then
        update public.crm_opportunities
          set stage_id = v_won_stage_id, status = 'won'
          where id = new.opportunity_id;
      end if;
    end if;
  end if;
  return new;
end;
$$;
