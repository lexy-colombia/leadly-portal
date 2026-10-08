-- Campos personalizados, parte 2: valores en clients.custom_fields + trigger
-- de validación (ÚNICA puerta: ficha, importación CSV, cualquier otro camino).
-- Forma: { "<definition_id>": valor }. text -> string (<=500); integer/decimal
-- -> número JSON; boolean -> true/false; date -> 'YYYY-MM-DD'; select -> string
-- dentro de options. JSON null = vaciar.

alter table public.clients
  add column custom_fields jsonb not null default '{}'::jsonb,
  add constraint clients_custom_fields_is_object check (jsonb_typeof(custom_fields) = 'object');

create or replace function public.validate_client_custom_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  k text;
  v jsonb;
  def record;
  def_id uuid;
  txt text;
  num numeric;
  d date;
begin
  -- Early-return barato: este trigger corre en TODA escritura de clientes
  -- (POS, webhook de WhatsApp, CRM). Sin cambios en custom_fields no consulta nada.
  if tg_op = 'INSERT' then
    if new.custom_fields is null or new.custom_fields = '{}'::jsonb then
      return new;
    end if;
  elsif new.custom_fields is not distinct from old.custom_fields then
    return new;
  end if;

  if jsonb_typeof(new.custom_fields) is distinct from 'object' then
    return new; -- lo rechaza el CHECK de la columna
  end if;

  for k, v in select key, value from jsonb_each(new.custom_fields) loop
    -- Solo las claves nuevas o con valor distinto; quitar una clave siempre se permite.
    if tg_op = 'UPDATE' and not ((old.custom_fields -> k) is distinct from v) then
      continue;
    end if;

    begin
      def_id := k::uuid;
    exception when invalid_text_representation then
      raise exception 'Campo personalizado desconocido: "%".', k using errcode = '23514';
    end;

    -- Solo el UUID canónico (minúsculas, con guiones, sin llaves): otra forma
    -- castearía bien pero guardaría una clave que ningún lector encuentra.
    if k <> def_id::text then
      raise exception 'Campo personalizado desconocido: "%".', k using errcode = '23514';
    end if;

    select id, name, field_type, options into def
    from public.custom_field_definitions
    where id = def_id
      and tenant_id = new.tenant_id
      and entity_type = 'client'
      and is_active
      and deleted_at is null;

    if not found then
      raise exception 'El campo personalizado "%" no existe o no está disponible para este negocio.', k
        using errcode = '23514';
    end if;

    if jsonb_typeof(v) = 'null' then
      continue;
    end if;

    case def.field_type
      when 'text' then
        if jsonb_typeof(v) <> 'string' then
          raise exception 'El campo "%" debe ser texto.', def.name using errcode = '23514';
        end if;
        if length(v #>> '{}') > 500 then
          raise exception 'El campo "%" admite máximo 500 caracteres.', def.name using errcode = '23514';
        end if;
      when 'integer' then
        if jsonb_typeof(v) <> 'number' then
          raise exception 'El campo "%" debe ser un número entero.', def.name using errcode = '23514';
        end if;
        num := (v #>> '{}')::numeric;
        if num <> trunc(num) or abs(num) > 9007199254740991 then
          raise exception 'El campo "%" debe ser un número entero.', def.name using errcode = '23514';
        end if;
      when 'decimal' then
        if jsonb_typeof(v) <> 'number' then
          raise exception 'El campo "%" debe ser un número.', def.name using errcode = '23514';
        end if;
        num := (v #>> '{}')::numeric;
        if abs(num) > 9007199254740991 then
          raise exception 'El campo "%" tiene un valor demasiado grande.', def.name using errcode = '23514';
        end if;
      when 'boolean' then
        if jsonb_typeof(v) <> 'boolean' then
          raise exception 'El campo "%" debe ser verdadero o falso.', def.name using errcode = '23514';
        end if;
      when 'date' then
        if jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\d{4}-\d{2}-\d{2}$' then
          raise exception 'El campo "%" debe ser una fecha con formato AAAA-MM-DD.', def.name using errcode = '23514';
        end if;
        begin
          d := (v #>> '{}')::date;
        exception when others then
          raise exception 'El campo "%" no es una fecha válida.', def.name using errcode = '23514';
        end;
      when 'select' then
        if jsonb_typeof(v) <> 'string' then
          raise exception 'El campo "%" debe ser una de las opciones de la lista.', def.name using errcode = '23514';
        end if;
        txt := v #>> '{}';
        if not (def.options ? txt) then
          raise exception 'El valor "%" no es una opción válida para el campo "%".', txt, def.name using errcode = '23514';
        end if;
      else
        raise exception 'Tipo de campo no soportado para "%".', def.name using errcode = '23514';
    end case;
  end loop;

  return new;
end;
$$;

revoke execute on function public.validate_client_custom_fields() from public, anon, authenticated;

create trigger clients_validate_custom_fields
  before insert or update of custom_fields on public.clients
  for each row execute function public.validate_client_custom_fields();
