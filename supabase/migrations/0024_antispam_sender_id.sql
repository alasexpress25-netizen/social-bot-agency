-- =========================================================
-- Propuesta 11 (PROPUESTAS-AGENCIA.md, 18/07/2026): anti-spam por
-- remitente repetido. daily_ai_reply_limit ya limita el consumo de IA por
-- CLIENTE, pero no por PERSONA -- si un mismo sender_id comenta o escribe
-- varias veces seguidas (spam, insistencia, alguien probando el sistema),
-- puede vaciar el cupo diario antes de que lleguen leads reales de otras
-- personas. Esta migracion agrega lo necesario para que meta-webhook pueda
-- contar cuantas interacciones tuvo un sender_id en la ultima hora:
--
--   1) sender_id en socialbot_interactions_log -- hoy esta tabla solo
--      guarda external_id (el id del comentario/mensaje), no quien lo
--      mando, asi que no se podia agrupar por remitente.
--   2) anti_spam_hourly_limit en socialbot_ai_settings -- opcional, permite
--      ajustar el limite por cliente (default en el codigo: 5 por hora si
--      la columna esta en null).
-- =========================================================

alter table socialbot_interactions_log
  add column if not exists sender_id text;

create index if not exists idx_interactions_log_client_sender_created
  on socialbot_interactions_log (client_id, sender_id, created_at);

alter table socialbot_ai_settings
  add column if not exists anti_spam_hourly_limit int;

comment on column socialbot_ai_settings.anti_spam_hourly_limit is
  'Cuantas interacciones (comentarios/DMs) tolerar del mismo sender_id en una hora antes de dejar de autoresponderle. NULL = usar el default del codigo (5).';
