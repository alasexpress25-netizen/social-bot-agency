-- =========================================================
-- Agrega "page_engagement" a socialbot_audience_reach: engagement total
-- (reacciones + comentarios + compartidos + clics) de TODOS los posts de
-- la Pagina de Facebook en los ultimos 28 dias (metric=page_post_engagements
-- de Facebook Page Insights).
--
-- Ver _fetch_facebook_page_engagement() en post_scheduler.py, llamada
-- desde collect_facebook_page_engagement() (funcion separada de
-- collect_audience_reach() porque esa filtra platform='instagram'). Es el
-- equivalente, para Facebook, de accounts_engaged para Instagram -- queda
-- en null para cuentas de Instagram, igual criterio que el resto de
-- columnas de esta tabla que son especificas de una sola plataforma.
-- =========================================================

alter table socialbot_audience_reach
  add column if not exists page_engagement int;

-- No hace falta ninguna policy nueva: es una columna nueva en una tabla que
-- ya tiene RLS habilitado y cubre la fila completa.
