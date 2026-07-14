-- =========================================================
-- 1) El cliente puede editar el texto (caption) de un post SOLO
--    mientras sigue pendiente de aprobacion. Igual que las otras
--    acciones del portal de cliente, corre server-side via RPC
--    SECURITY DEFINER: valida dueno de la fila y que siga 'pending'
--    antes de dejar tocar nada.
-- =========================================================
create or replace function public.client_edit_pending_post_caption(p_post_id uuid, p_caption text)
returns socialbot_posts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client_id uuid;
  v_row socialbot_posts;
begin
  if p_caption is null or length(trim(p_caption)) = 0 then
    raise exception 'el texto no puede quedar vacio';
  end if;

  select id into v_client_id from socialbot_clients where client_user_id = auth.uid();
  if v_client_id is null then
    raise exception 'no autorizado';
  end if;

  update socialbot_posts
    set caption = p_caption
    where id = p_post_id and client_id = v_client_id and approval_status = 'pending'
    returning * into v_row;

  if v_row.id is null then
    raise exception 'post no encontrado, no es tuyo, o ya fue revisado';
  end if;

  return v_row;
end;
$$;

revoke all on function public.client_edit_pending_post_caption(uuid, text) from public;
grant execute on function public.client_edit_pending_post_caption(uuid, text) to authenticated;


-- =========================================================
-- 2) Carrusel: varias imagenes en un mismo post (Facebook + Instagram).
-- =========================================================

-- Permite el nuevo media_type 'carousel' junto a los que ya existian.
alter table socialbot_media_assets
  drop constraint if exists socialbot_media_assets_media_type_check;
alter table socialbot_media_assets
  add constraint socialbot_media_assets_media_type_check
    check (media_type in ('image', 'video', 'carousel'));

-- Para un media_asset de tipo 'carousel', la columna 'url' queda en null
-- y las imagenes individuales viven aca, en el orden en que se publican.
create table if not exists socialbot_carousel_items (
  id uuid primary key default gen_random_uuid(),
  media_asset_id uuid references socialbot_media_assets(id) on delete cascade not null,
  url text not null,
  position int not null default 0,
  created_at timestamptz default now()
);

alter table socialbot_carousel_items enable row level security;

create policy "owner sees own carousel_items" on socialbot_carousel_items
  for all using (media_asset_id in (
    select ma.id from socialbot_media_assets ma
    join socialbot_clients c on c.id = ma.client_id
    join socialbot_agencies a on a.id = c.agency_id
    where a.owner_user_id = auth.uid()
  ));

-- El cliente puede VER (no editar) las imagenes de un carrusel propio,
-- para poder revisarlas antes de aprobar el post en su portal.
create policy "client sees own carousel_items" on socialbot_carousel_items
  for select using (media_asset_id in (
    select ma.id from socialbot_media_assets ma
    join socialbot_clients c on c.id = ma.client_id
    where c.client_user_id = auth.uid()
  ));


-- =========================================================
-- 3) socialbot_posts: referencia directa al media_asset usado, en vez de
--    reconstruirlo adivinando por 'url' (que ademas se rompe con
--    carruseles, que no tienen una unica url). Tambien guardamos el
--    media_type resuelto al momento de generar el post, para poder
--    mostrar "carrusel" en los paneles sin re-consultar el asset.
-- =========================================================
alter table socialbot_posts
  add column if not exists media_asset_id uuid references socialbot_media_assets(id) on delete set null;
alter table socialbot_posts
  add column if not exists media_type text;

comment on column socialbot_posts.media_asset_id is
  'Referencia directa al media_assets usado para generar este post (reemplaza la reconstruccion por url).';
comment on column socialbot_posts.media_type is
  'image | video | carousel. Copiado del media_asset al momento de crear el post, para no depender de que el asset original siga existiendo.';

-- No hace falta ninguna policy nueva para estas columnas: "owner sees own
-- posts" (0001) y "client sees own posts" (0006) ya cubren la fila
-- completa, columna por columna, para SELECT.
