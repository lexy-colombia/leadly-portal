set client_min_messages = warning;
create table t.results(n serial primary key, name text, ok boolean, detail text);
grant all on t.results to public; grant all on sequence t.results_n_seq to public;
create function t.ok(p_name text, p_cond boolean, p_detail text default null) returns void language sql as
$$ insert into t.results(name, ok, detail) values (p_name, coalesce(p_cond, false), p_detail) $$;
-- ejecuta sql dentro de un subbloque; devuelve 'ok' o 'SQLSTATE: mensaje' (y revierte sus efectos si falla)
create function t.try(p_sql text) returns text language plpgsql as $$
begin execute p_sql; return 'ok';
exception when others then return sqlstate || ': ' || sqlerrm; end $$;
-- igual, pero bajo un rol y un usuario (JWT simulado); siempre revierte el rol al terminar
create function t.try_as(p_role text, p_uid uuid, p_sql text) returns text language plpgsql as $$
declare r text;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute 'set local role ' || p_role;
  begin execute p_sql; r := 'ok';
  exception when others then r := sqlstate || ': ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return r;
end $$;
-- cuenta filas visibles bajo un rol/usuario
create function t.count_as(p_role text, p_uid uuid, p_sql text) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), true);
  execute 'set local role ' || p_role;
  execute 'select count(*) from (' || p_sql || ') q' into n;
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', '', true);
  return n;
exception when others then execute 'reset role'; return -1; end $$;
