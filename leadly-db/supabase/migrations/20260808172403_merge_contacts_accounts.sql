-- Reverts the B2B model (crm_accounts grouping several crm_contacts) --
-- commercially, each WhatsApp lead/approach ("acercamiento") IS the unit
-- opportunities attach to, there's no grouping of several people under one
-- company. crm_contacts already sustains everything else in the schema
-- (whatsapp_conversations, crm_notes, crm_pqrs, crm_appointments,
-- crm_opportunities.contact_id not null, crm_tasks) -- crm_accounts was the
-- thin, secondary table (only crm_contacts.account_id and
-- crm_opportunities.account_id referenced it), so it's the one absorbed and
-- dropped, not the other way around.
--
-- Also wipes all CRM demo/QA data (crm_contacts, crm_accounts and every
-- table hanging off them, plus whatsapp_conversations/whatsapp_messages) --
-- explicit user request, confirmed scope: no real WhatsApp traffic exists
-- yet, tenants/profiles/whatsapp_lines/ai_assistants/billing_*/payment_* are
-- untouched.

-- 1. Absorb crm_accounts' useful fields into crm_contacts. `name`~=`full_name`
-- and `owner_id`~=`assigned_to` already exist there, not duplicated.
alter table public.crm_contacts
  add column nit text,
  add column industry text,
  add column website text,
  add column address text,
  add column city text,
  add column notes text,
  add column is_active boolean not null default true;

-- 2. Wipe demo data, children before parents.
truncate table
  public.crm_attachments,
  public.crm_pqr_updates,
  public.crm_pqrs,
  public.crm_appointments,
  public.crm_tasks,
  public.crm_opportunity_stage_history,
  public.crm_opportunities,
  public.crm_notes,
  public.whatsapp_messages,
  public.whatsapp_conversations,
  public.crm_contacts
  restart identity cascade;

-- 3. Drop the B2B grouping FKs.
alter table public.crm_contacts drop column account_id;
alter table public.crm_opportunities drop column account_id;

-- 4. crm_accounts has nothing referencing it anymore.
drop table public.crm_accounts;

-- 5. Simplify the "leads" skill: it no longer searches/creates companies
-- (search_companies/create_company/link_contact_to_company tools removed
-- from _shared/aiTools.ts) -- only set_lead_stage remains.
update public.ai_skills
set
  name = 'Clasificación de leads',
  description = 'El asistente clasifica la etapa del contacto (lead, contactado, negociación, cliente, perdido) a medida que la conversación avanza.',
  prompt_fragment = 'Tenés una herramienta para clasificar en qué etapa del proceso de venta está este contacto -- usala en el momento correcto, sin anunciar ni explicar que la estás usando.

- set_lead_stage: actualizá el stage del contacto (lead, contactado, negociacion, cliente, perdido) a medida que la conversación avanza, para que el pipeline de contactos refleje la realidad sin que un agente tenga que hacerlo a mano.'
where key = 'leads';
