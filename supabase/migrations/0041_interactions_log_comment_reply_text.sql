-- =========================================================
-- Actualizacion 03/08/2026 (actualizacion_popup_comentarios.txt): guarda
-- el contenido de cada comentario/DM y la respuesta que el bot mando, para
-- poder mostrarlos en el popup de la card "Comentarios" (Interaccion en
-- publicaciones, metrics.js / Cliente.html). Antes de esto,
-- socialbot_interactions_log solo guardaba metadata (matched_keyword,
-- replied, sender_id) -- el texto pasaba por meta-webhook/index.ts para
-- decidir la respuesta pero nunca se persistia.
--
-- NO es retroactivo: las interacciones registradas antes de este cambio
-- van a tener estas 3 columnas en null (nunca se guardo su texto).
-- =========================================================

alter table socialbot_interactions_log
  add column if not exists comment_text text,
  add column if not exists reply_text text,
  add column if not exists external_post_id text;

comment on column socialbot_interactions_log.comment_text is
  'Texto del comentario/DM tal como llega de Meta. Guardado por claimInteraction() en meta-webhook/index.ts. Null para interacciones de antes de esta columna (no retroactivo).';
comment on column socialbot_interactions_log.reply_text is
  'Texto de la respuesta que el bot decidio mandar (IA, regla de palabra clave, o fallback de piso). Guardado por finishInteraction(). Puede haber texto aunque el envio a Meta haya fallado -- refleja lo que se intento mandar.';
comment on column socialbot_interactions_log.external_post_id is
  'Id del post de Meta al que pertenece el comentario (para poder agrupar/filtrar por publicacion). Null en DMs, y en comentarios donde Meta no informo el post de origen.';
