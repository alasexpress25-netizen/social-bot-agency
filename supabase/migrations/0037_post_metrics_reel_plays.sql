-- =========================================================
-- Agrega "plays" y "avg_watch_time_ms" a socialbot_post_metrics: cuantas
-- veces se reprodujo un Reel de Instagram y el tiempo promedio de
-- reproduccion (en milisegundos). Juntas dicen si la gente ve el video
-- completo o lo abandona a los primeros segundos.
--
-- Solo aplica a Reels (media_type local == 'video', que publish_instagram()
-- sube como REELS) -- ver _fetch_instagram_reel_metrics() y el bloque
-- correspondiente dentro de fetch_post_metrics() en post_scheduler.py.
-- Quedan en null para imagenes, carruseles y posts de Facebook, igual
-- criterio que 'saved' en esta misma tabla.
-- =========================================================

alter table socialbot_post_metrics
  add column if not exists plays int,
  add column if not exists avg_watch_time_ms int;

-- No hace falta ninguna policy nueva: son columnas nuevas en una tabla que
-- ya tiene RLS habilitado (0012_post_metrics.sql), que cubre la fila
-- completa.
