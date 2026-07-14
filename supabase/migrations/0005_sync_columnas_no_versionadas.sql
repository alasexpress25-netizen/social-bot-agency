-- =========================================================
-- Reconciliacion: estas 3 columnas ya existen y funcionan en produccion
-- (se agregaron directo desde el dashboard/SQL editor de Supabase, sin
-- bajar el archivo de migracion al repo). Este archivo no cambia nada en
-- la base real -- todo usa "if not exists" -- es solo para que el repo
-- quede fiel a lo que ya esta corriendo, y un proyecto nuevo creado desde
-- cero con estos archivos termine con el mismo esquema que produccion.
-- =========================================================

-- socialbot_posts: para poder linkear cada post publicado con la corrida
-- de GitHub Actions que lo genero (manual vs cron automatico).
alter table socialbot_posts
  add column if not exists trigger_source text;
comment on column socialbot_posts.trigger_source is
  'manual (workflow_dispatch) o schedule (cron automatico)';

alter table socialbot_posts
  add column if not exists github_run_id text;
comment on column socialbot_posts.github_run_id is
  'GITHUB_RUN_ID de la corrida que genero este post, para linkear directo al log';

-- socialbot_schedule_slots: permite horarios que no se repiten todos los
-- dias (ej. solo Lunes/Miercoles/Viernes) en vez de forzar 7 dias iguales.
alter table socialbot_schedule_slots
  add column if not exists day_of_week int check (day_of_week between 1 and 7);
comment on column socialbot_schedule_slots.day_of_week is
  'ISO weekday 1=Lunes..7=Domingo. NULL = aplica todos los dias.';

-- socialbot_media_assets: permite fijar a mano el texto del post (con
-- hashtags incluidos) para un recurso puntual, salteando la generacion
-- con IA para ese caso.
alter table socialbot_media_assets
  add column if not exists caption_override text;
comment on column socialbot_media_assets.caption_override is
  'Si se completa, el bot usa este texto TAL CUAL (con hashtags incluidos) en vez de generar uno con IA.';
