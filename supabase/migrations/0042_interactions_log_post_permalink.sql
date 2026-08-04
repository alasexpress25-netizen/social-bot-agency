-- =========================================================
-- Actualizacion 03/08/2026: el popup de comentarios (metrics.js,
-- openCommentsModal) intentaba mostrar el link a la publicacion
-- cruzando socialbot_interactions_log.external_post_id contra
-- socialbot_posts.external_post_id por igualdad de texto. Eso falla en
-- dos casos frecuentes:
--
--   1) publish_facebook() a veces guarda el external_post_id de
--      socialbot_posts con un sufijo legible pegado (ej. "123456 (foto
--      manual)", "123456 (fallback foto, video no habilitado aun)"),
--      mientras que el post_id/media.id que manda el webhook de Meta en
--      el evento de comentario viene limpio. La igualdad de texto nunca
--      matchea y el post queda "sin titulo guardado" / sin link, aunque
--      el post SI este guardado en socialbot_posts.
--   2) El comentario puede ser de un post que no vive en
--      socialbot_posts (publicado fuera del panel, o borrado del panel
--      despues).
--
-- Solucion: en vez de reconstruir el link despues via join, el propio
-- meta-webhook/index.ts pide el permalink a la Graph API en el momento
-- en que llega el comentario (mismo patron que _build_permalink() en
-- post_scheduler.py) y lo persiste directo en la fila del comentario.
-- Asi el popup deja de depender del match con socialbot_posts.
-- =========================================================

alter table socialbot_interactions_log
  add column if not exists post_permalink_url text;

comment on column socialbot_interactions_log.post_permalink_url is
  'Link directo a la publicacion de Meta a la que pertenece el comentario, pedido a la Graph API por meta-webhook/index.ts en el momento en que llega el comentario (no via join con socialbot_posts, que puede no matchear -- ver migracion 0042). Null en DMs y si la Graph API no pudo devolverlo.';
