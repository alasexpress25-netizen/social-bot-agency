-- Item 8 de PROPUESTAS-AGENCIA.md: reseñas de Google/Facebook monitoreadas.
-- Mismo patrón que el resto del repo: una tabla por-cliente con RLS de
-- "owner sees own X" + "client sees own X" (portal), poblada por un
-- scheduler externo (scheduler/reviews_monitor.py) en vez de un trigger,
-- porque no reacciona a un insert propio sino que va a buscar reseñas
-- nuevas a APIs externas (Facebook Graph API / Google Places API).

alter table socialbot_clients
  add column if not exists google_place_id text;

create table if not exists socialbot_reviews (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  platform text not null check (platform in ('google', 'facebook')),
  external_id text not null,
  author_name text,
  rating int check (rating between 1 and 5),          -- Google: 1-5. Facebook no tiene rating.
  recommendation_type text check (recommendation_type in ('positive', 'negative', null)), -- Facebook: recomienda / no recomienda
  review_text text,
  suggested_reply text,
  status text not null default 'nueva' check (status in ('nueva', 'respondida', 'ignorada')),
  review_created_at timestamptz,
  created_at timestamptz default now(),
  unique (platform, external_id)
);

alter table socialbot_reviews enable row level security;

create policy "owner sees own reviews" on socialbot_reviews
  for all using (
    client_id in (
      select c.id from socialbot_clients c
      join socialbot_agencies a on a.id = c.agency_id
      where a.owner_user_id = auth.uid()
    )
  );

-- El scheduler externo usa la service_role key (bypassa RLS), así que no
-- hace falta una policy para él. El cliente (portal) no necesita ver
-- reseñas por ahora -- esto es una herramienta de la agencia -- se puede
-- sumar una policy "client sees own reviews" el día que se quiera mostrar
-- en cliente.html.

create index if not exists idx_socialbot_reviews_client_status
  on socialbot_reviews(client_id, status);
