-- =========================================================
-- FASE 6 (parte 1): metricas de cada post publicado (likes, comentarios,
-- compartidos, alcance/reach), traidas de Meta Graph API. Hasta ahora el
-- sistema sabia QUE se publico pero no como le fue -- esto le da a la Fase
-- 6 (plan de contenido con IA) datos reales de que funciono y que no, en
-- vez de improvisar.
--
-- Guardamos un solo snapshot por post (la fila mas reciente pisa a la
-- anterior via upsert por post_id), no un historico completo -- alcanza
-- para "que tan bien le fue a este post" sin complicar el esquema. Si el
-- dia de mañana hace falta ver evolucion en el tiempo, se puede sacar el
-- unique y pasar a insert-only con created_at.
--
-- Ya aplicada en producción (redaqqxoeciycqgjhpbv), 15/07/2026. Este
-- archivo es solo para que el repo quede fiel a lo que ya está corriendo.
-- =========================================================

create table if not exists socialbot_post_metrics (
  id uuid primary key default gen_random_uuid(),
  post_id uuid references socialbot_posts(id) on delete cascade not null unique,
  likes int default 0,
  comments int default 0,
  shares int default 0,
  reach int,
  impressions int,
  fetched_at timestamptz default now()
);

alter table socialbot_post_metrics enable row level security;

create policy "owner sees own post_metrics" on socialbot_post_metrics
  for all using (post_id in (
    select p.id from socialbot_posts p
    join socialbot_clients c on c.id = p.client_id
    join socialbot_agencies a on a.id = c.agency_id
    where a.owner_user_id = auth.uid()
  ));

-- El cliente puede VER (no editar) las metricas de sus propios posts, por si
-- mas adelante se muestran en su portal junto al historial de publicaciones.
create policy "client sees own post_metrics" on socialbot_post_metrics
  for select using (post_id in (
    select p.id from socialbot_posts p
    join socialbot_clients c on c.id = p.client_id
    where c.client_user_id = auth.uid()
  ));

-- service_role (scheduler) escribe estas filas directo, bypassea RLS como
-- el resto de las tablas socialbot_*.
