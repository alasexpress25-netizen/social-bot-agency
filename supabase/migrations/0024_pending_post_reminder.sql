-- =========================================================
-- Propuesta 12 (PROPUESTAS-AGENCIA.md, 18/07/2026): recordatorio de posts
-- pendientes de aprobacion. notify-pending-post (migracion 0009) ya avisa
-- por email UNA vez, apenas se crea el post (trigger de insert). Si el
-- cliente no lo aprueba/rechaza en X horas, no hay ningun segundo aviso --
-- el post puede quedar esperando dias sin que nadie se acuerde.
--
-- A diferencia del aviso inicial (evento por fila, via pg_net), este es un
-- chequeo PERIODICO por tiempo transcurrido -- mismo patron que
-- notify-stale-leads (item 2): un cron de GitHub Actions le pega por HTTP a
-- una Edge Function, que busca posts todavia 'pending' mas viejos que un
-- umbral. reminder_sent_at evita mandar el recordatorio mas de una vez por
-- post.
-- =========================================================

alter table socialbot_posts
  add column if not exists reminder_sent_at timestamptz;

comment on column socialbot_posts.reminder_sent_at is
  'Cuando se mando el email de recordatorio de aprobacion pendiente (notify-pending-post-reminder). NULL = todavia no se mando ninguno.';

create index if not exists idx_posts_pending_approval_created
  on socialbot_posts (approval_status, created_at)
  where approval_status = 'pending';
