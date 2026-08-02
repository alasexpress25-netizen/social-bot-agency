-- =========================================================
-- Agrega "accounts_engaged" a socialbot_audience_reach: cuantas cuentas
-- UNICAS interactuaron (like, comment, save, share) con el contenido de
-- Instagram en los ultimos 28 dias. Junto con follower_reach +
-- non_follower_reach, permite calcular un % de engagement real sobre el
-- alcance (accounts_engaged / alcance total) en vez de solo sumar
-- likes+comments como proxy indirecto.
--
-- Ver _fetch_instagram_account_engagement() en post_scheduler.py (misma
-- llamada a /insights que ya trae profile_views, sin requests
-- adicionales), llamada desde collect_audience_reach(). Es Instagram-only
-- (Facebook no tiene esta metrica de cuenta), igual que el resto de
-- columnas de esta tabla -- queda en null para cuentas de Facebook.
-- =========================================================

alter table socialbot_audience_reach
  add column if not exists accounts_engaged int;

-- No hace falta ninguna policy nueva: es una columna nueva en una tabla que
-- ya tiene RLS habilitado y cubre la fila completa.
