-- Agrega columna para que el cliente pueda cargar manualmente una foto
-- (capturada por el/ella) que se use en Facebook en vez del video, cuando
-- el media_type es 'video'. Instagram sigue publicando el video normal;
-- esto solo aplica al fallback de Facebook.
alter table socialbot_media_assets
  add column if not exists fb_photo_url text;
