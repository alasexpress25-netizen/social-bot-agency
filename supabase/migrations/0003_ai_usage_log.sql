-- =========================================================
-- FASE 1: uso prudente de IA en el webhook (Groq free tier)
-- =========================================================

-- Limite diario de respuestas con IA por cliente (configurable).
-- Con esto en 0 o NULL, el sistema usa el limite global por defecto (30/dia)
-- definido en el codigo del webhook.
alter table socialbot_ai_settings
  add column if not exists daily_ai_reply_limit int default 30;

-- Registro de uso diario de IA por cliente. Un row por (cliente, dia).
create table if not exists socialbot_ai_usage_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  usage_date date not null default current_date,
  call_count int not null default 0,
  updated_at timestamptz default now(),
  unique (client_id, usage_date)
);

alter table socialbot_ai_usage_log enable row level security;

-- Solo el service_role (usado por el webhook y el scheduler) escribe/lee esta
-- tabla directamente; no se expone a anon ni a clientes.
create policy "service role full access ai_usage_log"
  on socialbot_ai_usage_log
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');

-- Cache simple de respuestas de IA para preguntas repetidas/similares, asi
-- no se vuelve a gastar cuota de Groq por la misma consulta.
create table if not exists socialbot_ai_reply_cache (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  question_normalized text not null,
  reply text not null,
  hits int not null default 1,
  created_at timestamptz default now(),
  unique (client_id, question_normalized)
);

alter table socialbot_ai_reply_cache enable row level security;

create policy "service role full access ai_reply_cache"
  on socialbot_ai_reply_cache
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
