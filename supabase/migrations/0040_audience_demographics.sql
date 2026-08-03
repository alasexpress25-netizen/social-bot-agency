-- =========================================================
-- Actualizacion 03/08/2026 (actualizacion_posts_y_metricas.txt, Parte 2):
-- snapshot demografico de audiencia (genero+edad, pais, ciudad) por cuenta
-- conectada. Poblada por collect_audience_demographics() en
-- scheduler/metrics_collector.py:
--   - Instagram: los 3 breakdown_type via follower_demographics
--     (gender_age, country, city).
--   - Facebook: solo country/city via page_follows_country/city -- Meta
--     deprecó genero/edad de Paginas en marzo 2024 sin reemplazo, asi que
--     gender_age queda vacio para cuentas platform='facebook' a proposito.
--
-- Se guarda solo el ultimo snapshot por cuenta (upsert por
-- social_account_id+breakdown_type+breakdown_key, igual criterio que
-- socialbot_audience_reach) -- antes de cada corrida, sb_delete() limpia
-- las claves de ese breakdown_type que ya no vinieron (ej. una ciudad que
-- salio del top-45 de Meta), para no dejar valores huerfanos.
--
-- NOTA: esta migracion se aplico directo contra la base real
-- (redaqqxoeciycqgjhpbv) el 03/08/2026 y quedo fuera del repo por un
-- descuido al armar el zip -- se reconstruye acá 1:1 contra el schema
-- que ya esta viva en produccion (columnas, constraints, indices y
-- policies verificados contra la base real antes de commitear este
-- archivo), para que quede versionada sin volver a tocar la tabla.
-- =========================================================

create table socialbot_audience_demographics (
  id uuid primary key default gen_random_uuid(),
  social_account_id uuid not null references socialbot_social_accounts(id) on delete cascade,
  -- 'gender_age' (clave tipo 'F.35-44'), 'country' (codigo/nombre de pais
  -- tal cual lo devuelve Meta) o 'city'.
  breakdown_type text not null check (breakdown_type in ('gender_age', 'country', 'city')),
  breakdown_key text not null,
  -- Porcentaje o conteo, segun lo que devuelva Meta para ese breakdown.
  value numeric not null,
  fetched_at timestamptz not null default now(),
  unique (social_account_id, breakdown_type, breakdown_key)
);

comment on table socialbot_audience_demographics is
  'Snapshot demografico de audiencia (genero+edad, pais, ciudad) por cuenta social conectada. Poblada por collect_audience_demographics() en scheduler/metrics_collector.py. Solo el ultimo snapshot por cuenta (se pisa/limpia en cada corrida via sb_upsert + sb_delete).';

alter table socialbot_audience_demographics enable row level security;

create policy "client sees own audience_demographics"
  on socialbot_audience_demographics
  for select
  using (
    social_account_id in (
      select sa.id
      from socialbot_social_accounts sa
      join socialbot_clients c on c.id = sa.client_id
      where c.client_user_id = auth.uid()
    )
  );

create policy "owner sees own audience_demographics"
  on socialbot_audience_demographics
  for all
  using (
    social_account_id in (
      select sa.id
      from socialbot_social_accounts sa
      join socialbot_clients c on c.id = sa.client_id
      join socialbot_agencies a on a.id = c.agency_id
      where a.owner_user_id = auth.uid()
    )
  );
