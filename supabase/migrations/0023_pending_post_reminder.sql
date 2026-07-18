-- =========================================================
-- Propuesta 12 (PROPUESTAS-AGENCIA.md, 18/07/2026): recordatorio de posts
-- pendientes de aprobacion. Agrega la columna que usa
-- remind-pending-post/index.ts para no mandar el mismo recordatorio mas de
-- una vez por post.
--
-- Ya aplicada en produccion (redaqqxoeciycqgjhpbv) en otra sesion, junto
-- con el deploy de la Edge Function remind-pending-post -- ese trabajo no
-- habia quedado reflejado en este repo. Este archivo es solo para que el
-- repo quede fiel a lo que ya esta corriendo (mismo criterio que
-- 0009_agency_approval_and_pending_notification.sql).
-- =========================================================

alter table socialbot_posts
  add column if not exists approval_reminder_sent_at timestamptz;

comment on column socialbot_posts.approval_reminder_sent_at is
  'Cuando se mando el email de recordatorio de aprobacion pendiente (remind-pending-post). NULL = todavia no se mando ninguno.';
