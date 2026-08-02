-- =========================================================
-- Agrega "profile_views" a socialbot_audience_reach: cuanta gente visito
-- el perfil de Instagram (no solo vio un post) en los ultimos 28 dias.
-- Ver _fetch_instagram_profile_views() en post_scheduler.py, llamada desde
-- collect_audience_reach() junto al alcance seguidor/no-seguidor que ya se
-- traia. Es Instagram-only (Facebook no tiene metrica equivalente para
-- Paginas), igual que follower_reach/non_follower_reach en esta misma
-- tabla -- queda en null para cuentas de Facebook.
-- =========================================================

alter table socialbot_audience_reach
  add column if not exists profile_views int;

-- No hace falta ninguna policy nueva: es una columna nueva en una tabla que
-- ya tiene RLS habilitado y cubre la fila completa.
