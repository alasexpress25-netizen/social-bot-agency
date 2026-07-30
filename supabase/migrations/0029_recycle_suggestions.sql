-- Punto 6 de propuestas-30-07-2026.md: reciclado de contenido ganador. Un
-- post que funciono muy bien hace 3-4 meses, reformulado con angulo nuevo,
-- suele volver a funcionar -- hasta ahora nada hacia esto automaticamente.
--
-- content_planner.py ahora busca, por cliente, el post con mejor score de
-- enganche entre 90 y 200 dias de antiguedad y se lo pasa a la IA como
-- "candidato a reciclar" dentro del plan semanal. Esta tabla solo evita
-- sugerir el MISMO post reciclado en corridas seguidas (se pide de nuevo
-- recien despues de RECYCLE_COOLDOWN_DAYS, ver content_planner.py) -- no
-- hace falta enlazar el post original con la idea nueva generada, alcanza
-- con no repetir la sugerencia demasiado seguido.
create table socialbot_recycle_suggestions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  post_id uuid references socialbot_posts(id) on delete cascade not null,
  suggested_at timestamptz default now()
);

create index on socialbot_recycle_suggestions (client_id, suggested_at);

alter table socialbot_recycle_suggestions enable row level security;

create policy "owner sees own recycle_suggestions" on socialbot_recycle_suggestions
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));
