-- =========================================================
-- socialbot_ai_settings.reply_language (agregado en 0018) hasta ahora solo
-- controlaba el idioma de las respuestas automaticas del meta-webhook a
-- comentarios/DMs. A partir de esta migracion, content_planner.py (plan
-- semanal) y post_scheduler.py (fallback diario de caption) tambien leen
-- este mismo campo para escribir los POSTS en el idioma correcto del
-- cliente -- no se agrega columna nueva, se amplia el alcance de la que ya
-- existia. Motivo: clientes de habla hispana (ej. Alas Tecno) estaban
-- recibiendo posts en portugues porque el default de la columna es 'pt-BR'
-- y nadie lo estaba pisando para la generacion de posts.
--
-- Nota: el valor 'auto' (detectar idioma del mensaje entrante) solo tiene
-- sentido para respuestas a comentarios/DMs, no para un post nuevo sin
-- mensaje de referencia -- en ese caso content_planner.py/post_scheduler.py
-- lo tratan como español.
-- =========================================================

comment on column socialbot_ai_settings.reply_language is
  'Idioma del contenido generado por IA para este cliente: se usa tanto para las respuestas automaticas del meta-webhook a comentarios/DMs como para los posts generados por content_planner.py y post_scheduler.py. "pt-BR" o "es" fuerzan ese idioma siempre; "auto" hace que la IA detecte y responda en el mismo idioma del comentario/DM entrante (solo aplica a respuestas, no a posts nuevos).';
