-- =========================================================
-- Punto 3 de propuestas-30-07-2026.md: historial de engagement rate por
-- cliente, para poder comparar % de variacion vs. el periodo anterior en
-- el panel (metrics.js / Cliente.html) -- socialbot_audience_reach solo
-- guarda el ULTIMO snapshot por cuenta (se pisa en cada corrida), asi que
-- no alcanza para eso.
--
-- Guarda 1 fila por cliente por dia (no por cuenta social -- el
-- engagement rate que se muestra en el panel ya es la suma de todas las
-- cuentas de Instagram del cliente, ver renderMetrics() en metrics.js),
-- poblada por un nuevo collect_engagement_snapshots() en
-- scheduler/metrics_collector.py que corre justo despues de
-- collect_audience_reach() (que es quien ya trajo los numeros frescos de
-- Meta para ese dia).
-- =========================================================

create table socialbot_engagement_snapshots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references socialbot_clients(id) on delete cascade,
  snapshot_date date not null default ((now() at time zone 'utc')::date),
  -- accounts_engaged / audience_reach * 100, redondeado a 2 decimales.
  -- Null si ese dia no habia dato suficiente (mismo criterio "null = sin
  -- dato todavia" que el resto del proyecto).
  engagement_rate numeric(5,2),
  -- Numeros crudos que arman el % de arriba, guardados aparte por si en
  -- algun momento hace falta mostrarlos sueltos (no solo el %).
  accounts_engaged int,
  audience_reach int,
  fetched_at timestamptz not null default now(),
  unique (client_id, snapshot_date)
);

comment on table socialbot_engagement_snapshots is
  'Historial diario de engagement rate agregado por cliente (todas sus cuentas de Instagram), 1 fila por cliente por dia. Poblada por collect_engagement_snapshots() en scheduler/metrics_collector.py. Se usa para el % de variacion vs. periodo anterior en metrics.js/Cliente.html.';

alter table socialbot_engagement_snapshots enable row level security;

create policy "client sees own engagement_snapshots"
  on socialbot_engagement_snapshots
  for select
  using (
    client_id in (
      select id from socialbot_clients where client_user_id = auth.uid()
    )
  );

create policy "owner sees own engagement_snapshots"
  on socialbot_engagement_snapshots
  for all
  using (
    client_id in (
      select c.id from socialbot_clients c
      join socialbot_agencies a on a.id = c.agency_id
      where a.owner_user_id = auth.uid()
    )
  );
