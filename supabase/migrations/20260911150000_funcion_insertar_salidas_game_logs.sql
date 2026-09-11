-- Registro de la migración ya aplicada al proyecto. La base es la fuente de
-- verdad; este archivo existe para poder leer en el repo qué cambió y por qué.
--
-- RPC de soporte para la Edge Function sincronizar-stats (modo=salidas). Existe porque
-- el unique index real de game_logs para deduplicar por game_pk es parcial
-- (game_logs_pitcher_juego_unico: UNIQUE (pitcher, game_pk) WHERE game_pk IS NOT NULL),
-- y Postgres solo usa un indice unico parcial como arbitro de ON CONFLICT si el WHERE
-- de la sentencia coincide con el predicado del indice -- el upsert() de supabase-js/
-- PostgREST no permite mandar ese WHERE, asi que un upsert directo desde la Edge
-- Function falla con "no unique or exclusion constraint matching". Esta funcion hace
-- el INSERT ... ON CONFLICT ... WHERE ... DO NOTHING correcto server-side.
create or replace function insertar_salidas_game_logs(filas jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  insertadas integer;
begin
  with datos as (
    select
      f->>'pitcher' as pitcher,
      nullif(f->>'fecha','')::date as fecha,
      f->>'rival' as rival,
      nullif(f->>'ip','')::numeric as ip,
      nullif(f->>'k','')::int as k,
      nullif(f->>'bb','')::int as bb,
      nullif(f->>'pitcheos','')::int as pitcheos,
      nullif(f->>'es_local','')::boolean as es_local,
      nullif(f->>'game_pk','')::int as game_pk
    from jsonb_array_elements(filas) as f
  ),
  insertado as (
    insert into game_logs (pitcher, fecha, rival, ip, k, bb, pitcheos, es_local, game_pk)
    select pitcher, fecha, rival, ip, k, bb, pitcheos, es_local, game_pk
    from datos
    where pitcher is not null and fecha is not null and rival is not null
      and ip is not null and k is not null and bb is not null and game_pk is not null
    on conflict (pitcher, game_pk) where game_pk is not null do nothing
    returning 1
  )
  select count(*) into insertadas from insertado;
  return insertadas;
end;
$$;

revoke all on function insertar_salidas_game_logs(jsonb) from public;
grant execute on function insertar_salidas_game_logs(jsonb) to service_role;
