-- =========================================================
-- Deja de reintentar para siempre las metricas de posts que fallan de forma
-- permanente (el cliente borro el post desde Instagram/Facebook, oculto los
-- likes, cambiaron permisos de la Pagina, etc.). Hasta ahora
-- collect_post_metrics() volvia a pedirle a Meta Graph API los mismos posts
-- "muertos" en TODAS las corridas (cada 15 min, para siempre, sin memoria de
-- que ya habian fallado antes) -- esto generaba ruido en el log y llamadas
-- de API desperdiciadas sin ningun beneficio.
--
-- metrics_fetch_failures: contador de fallos consecutivos trayendo metricas
--   de este post. Se resetea a 0 apenas un intento tiene exito.
-- metrics_last_fetch_attempt: cuando fue el ultimo intento (exitoso o no).
--   Una vez que metrics_fetch_failures llega al umbral (ver
--   MAX_METRICS_FETCH_FAILURES en post_scheduler.py), el post solo se
--   vuelve a intentar 1 vez por dia en vez de en cada corrida -- por si el
--   problema era transitorio (ej. la Pagina recupero permisos), sin volver
--   a machacar la API en cada corrida mientras tanto.
-- =========================================================

alter table socialbot_posts
  add column if not exists metrics_fetch_failures int not null default 0,
  add column if not exists metrics_last_fetch_attempt timestamptz;

-- Indice para el filtro de collect_post_metrics() (status + published_at ya
-- se benefician de escaneos chicos porque status='published' filtra mucho;
-- este indice ayuda especificamente al OR con metrics_fetch_failures).
create index if not exists idx_socialbot_posts_metrics_retry
  on socialbot_posts (status, published_at, metrics_fetch_failures);

-- No hace falta ninguna policy nueva: son columnas nuevas en una tabla que
-- ya tiene RLS habilitado (0001_init.sql, "owner sees own posts"), que
-- cubre la fila completa.
