create table if not exists public.t_conc(v text);
grant all on public.t_conc to service_role;
truncate public.t_conc;
