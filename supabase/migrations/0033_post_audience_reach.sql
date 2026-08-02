-- =========================================================
-- Desglose seguidor/no-seguidor a nivel de POST (no de cuenta). Hasta ahora
-- socialbot_audience_reach solo guardaba un total por CUENTA de Instagram
-- (ultimos 28 dias, collect_audience_reach() en post_scheduler.py) -- esto
-- agrega el mismo tipo de dato pero por publicacion individual, para poder
-- mostrar en cada post algo parecido a lo que Meta ya muestra nativamente
-- en "Insights do post" (Facebook/Instagram app), donde se ve que % del
-- alcance de ESE post vino de gente que ya seguia la cuenta vs. gente que
-- no.
--
-- Solo aplica a Instagram: la Graph API no expone un desglose equivalente
-- por publicacion para Paginas de Facebook (ver nota en
-- _fetch_instagram_post_audience_reach en post_scheduler.py) -- por eso
-- estas columnas van a quedar en null para los posts de Facebook, igual
-- que ya pasa con 'saved'.
-- =========================================================

alter table socialbot_post_metrics
  add column if not exists follower_reach int,
  add column if not exists non_follower_reach int;

-- No hace falta ninguna policy nueva: son columnas nuevas en una tabla que
-- ya tiene RLS habilitado (0012_post_metrics.sql, "owner sees own
-- post_metrics" / "client sees own post_metrics"), que cubre la fila
-- completa.
