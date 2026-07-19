-- Fix del filtro de plataforma en el portal de cliente (item 15 de
-- PROPUESTAS-AGENCIA.md). El frontend armaba el filtro haciendo un join
-- contra socialbot_social_accounts, pero esa tabla solo es legible por la
-- agencia (política "owner sees own social_accounts", ver 0001_init.sql) --
-- el usuario cliente nunca recibia el dato de plataforma via ese join, asi
-- que filtrar por Facebook/Instagram en cliente.html siempre daba vacio.
--
-- Solucion: guardar la plataforma directamente en cada fila de
-- socialbot_posts (se conoce en el momento de crear el post, no hace falta
-- ir a buscarla a otra tabla). Evita el problema de RLS de raiz y de paso
-- simplifica las queries del frontend (ya no hace falta el embed).
alter table socialbot_posts
  add column if not exists platform text check (platform in ('facebook', 'instagram'));

comment on column socialbot_posts.platform is
  'Copia de socialbot_social_accounts.platform al momento de crear el post. Evita depender de un join contra una tabla que el cliente no puede leer por RLS.';

-- Backfill de posts existentes (antes de este cambio, platform quedaba null).
update socialbot_posts p
set platform = sa.platform
from socialbot_social_accounts sa
where p.social_account_id = sa.id
  and p.platform is null;
