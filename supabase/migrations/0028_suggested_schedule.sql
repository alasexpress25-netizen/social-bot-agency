-- Propuesta 5 (propuestas-30-07-2026.md, 30/07/2026): parte visual del
-- "mejor horario sugerido por engagement real". La logica de calculo
-- (best_times_from_scored) ya existia en content_planner.py y se usaba
-- solo dentro del prompt de la IA -- esta tabla persiste ese resultado
-- para que el panel de agencia lo muestre en la pestaña "Horarios" de
-- cada cliente, sin tener que correr el planner para verlo.
--
-- Se borra y se vuelve a insertar en cada corrida de content_planner.py
-- (no hay historial, solo el ranking vigente).
create table socialbot_suggested_schedule (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  day_of_week int not null check (day_of_week between 0 and 6), -- 0=lunes .. 6=domingo (Python weekday())
  hour int not null check (hour between 0 and 23),
  avg_score numeric not null,
  sample_size int not null,
  computed_at timestamptz default now()
);

create index on socialbot_suggested_schedule (client_id);

alter table socialbot_suggested_schedule enable row level security;

create policy "owner sees own suggested_schedule" on socialbot_suggested_schedule
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));
