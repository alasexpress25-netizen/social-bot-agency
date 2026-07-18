-- Item 15 de PROPUESTAS-AGENCIA.md ("Link a la publicación real").
-- Guarda la URL publica de cada post exitosamente publicado (Facebook o
-- Instagram), para que agencia y cliente puedan verla con un click en vez
-- de tener que ir a buscarla a mano en la red social.
alter table socialbot_posts
  add column if not exists permalink_url text;

comment on column socialbot_posts.permalink_url is
  'URL publica del post ya publicado (Facebook: construida con el external_post_id; Instagram: field permalink de Graph API). Null si status != published o si Meta no la devolvio.';
