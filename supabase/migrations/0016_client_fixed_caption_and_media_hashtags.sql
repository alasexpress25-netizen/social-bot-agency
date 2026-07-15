-- =========================================================
-- FASE 6.2: cierra el hueco de prioridades entre agencia/cliente/IA para
-- caption y hashtags (pedido agencia, 15/07/2026).
--
-- Hasta ahora:
--   - socialbot_media_assets.caption_override: caption fijo por medio,
--     cargado SOLO por la agencia (frontend/index.html).
--   - socialbot_ai_settings.default_hashtags: hashtags de marca, pero
--     compartidos en la misma columna entre agencia y cliente -- lo que
--     escribiera el ultimo pisaba al otro, sin ninguna prioridad real.
--
-- Ahora cada lado tiene sus propios campos, y la prioridad al publicar
-- (post_scheduler.py) queda:
--   1) item del plan semanal ya aprobado por la agencia (si existe para hoy)
--   2) caption/hashtags fijos del CLIENTE (client_fixed_caption / client_hashtags)
--   3) caption/hashtags fijos de la AGENCIA para ese medio puntual
--      (caption_override / hashtags_override)
--   4) generacion automatica con IA
--
-- Ya aplicada en produccion (redaqqxoeciycqgjhpbv) directo via MCP de
-- Supabase. Este archivo es solo para que el repo quede fiel a lo que ya
-- esta corriendo -- usa "if not exists" / CREATE OR REPLACE, no cambia
-- nada en la base real.
-- =========================================================

-- ---------------------------------------------------------------------------
-- 1) Hashtags fijos por MEDIO, del lado de la agencia (hermano de
--    caption_override, que ya existia). Se suman al final del
--    caption_override al publicar (post_scheduler.py).
-- ---------------------------------------------------------------------------
alter table socialbot_media_assets
  add column if not exists hashtags_override text;

comment on column socialbot_media_assets.hashtags_override is
  'Hashtags fijos para este medio, cargados por la agencia junto al caption_override. Se agregan al final del caption_override al publicar (scheduler/post_scheduler.py).';

-- ---------------------------------------------------------------------------
-- 2) Separa los hashtags del cliente de los de la agencia (antes
--    compartian default_hashtags) y agrega el caption fijo del cliente.
-- ---------------------------------------------------------------------------
alter table socialbot_ai_settings
  add column if not exists client_hashtags text;

comment on column socialbot_ai_settings.client_hashtags is
  'Hashtags de marca fijos cargados por el CLIENTE desde su portal (frontend/cliente.html, RPC client_update_hashtags). Tienen prioridad sobre default_hashtags (agencia) al generar el plan semanal en content_planner.py y al publicar en post_scheduler.py.';

alter table socialbot_ai_settings
  add column if not exists client_fixed_caption text;

comment on column socialbot_ai_settings.client_fixed_caption is
  'Caption fijo (texto completo del post) cargado por el CLIENTE desde su portal. Maxima prioridad al publicar (por encima del caption_override de la agencia y de la generacion con IA), salvo que haya un item del plan semanal ya aprobado para el dia.';

comment on column socialbot_ai_settings.default_hashtags is
  'Hashtags de marca fijos cargados por la AGENCIA (frontend/index.html). Sirven de base cuando el cliente no cargo los suyos (client_hashtags).';

-- ---------------------------------------------------------------------------
-- 3) RPC para que el cliente edite su caption fijo desde su portal, mismo
--    patron que client_update_hashtags (0015) / client_update_ai_prefs (0006).
-- ---------------------------------------------------------------------------
create or replace function public.client_update_fixed_caption(p_caption text)
returns socialbot_ai_settings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_row socialbot_ai_settings;
begin
  select id into v_client_id from socialbot_clients where client_user_id = auth.uid();
  if v_client_id is null then
    raise exception 'no autorizado';
  end if;

  update socialbot_ai_settings
    set client_fixed_caption = p_caption
    where client_id = v_client_id
    returning * into v_row;

  if v_row.id is null then
    raise exception 'configuracion de ia no encontrada para este cliente';
  end if;

  return v_row;
end;
$$;

revoke all on function public.client_update_fixed_caption(text) from public;
grant execute on function public.client_update_fixed_caption(text) to authenticated;

-- No hace falta ninguna policy nueva: "owner sees own ai_settings" (0001)
-- y "client sees own ai_settings" (0006, solo SELECT) ya cubren la fila
-- completa para lectura; la escritura del cliente pasa siempre por RPC
-- SECURITY DEFINER (client_update_hashtags, client_update_fixed_caption),
-- nunca por UPDATE directo de tabla.
