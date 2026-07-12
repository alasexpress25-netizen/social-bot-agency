-- =========================================================
-- SOCIALBOT: plataforma de automatización de redes (agencia)
-- Ya aplicada en el proyecto: redaqqxoeciycqgjhpbv
-- (la.visualmk@gmail.com's Project)
-- Todas las tablas van prefijadas con socialbot_ para no
-- mezclarse con el resto de las tablas de este proyecto.
-- =========================================================

create extension if not exists pg_cron;
create extension if not exists pg_net;

create table socialbot_agencies (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid references auth.users(id) not null,
  name text not null,
  created_at timestamptz default now()
);

create table socialbot_clients (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid references socialbot_agencies(id) on delete cascade not null,
  name text not null,
  sales_link text,
  timezone text default 'America/Sao_Paulo',
  active boolean default true,
  created_at timestamptz default now()
);

create table socialbot_social_accounts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  platform text not null check (platform in ('facebook', 'instagram')),
  page_id text not null,
  ig_business_id text,
  page_name text,
  page_access_token text not null,
  token_expires_at timestamptz,
  connected_at timestamptz default now(),
  unique (client_id, platform, page_id)
);

create table socialbot_ai_settings (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade unique not null,
  provider text not null default 'groq' check (provider in ('groq','openai','claude')),
  system_prompt text not null default 'Sos un community manager. Escribí un post corto, atractivo, con emojis moderados y un llamado a la acción claro. Nunca repitas el mismo texto.',
  topics text,
  tone text default 'cercano y profesional',
  max_chars int default 400
);

create table socialbot_media_assets (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  url text not null,
  media_type text default 'image' check (media_type in ('image','video')),
  tags text,
  times_used int default 0,
  created_at timestamptz default now()
);

create table socialbot_schedule_slots (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  hour int not null check (hour between 0 and 23),
  minute int not null default 0 check (minute between 0 and 59),
  active boolean default true
);

create table socialbot_posts (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  social_account_id uuid references socialbot_social_accounts(id) on delete cascade not null,
  caption text,
  media_url text,
  status text default 'pending' check (status in ('pending','publishing','published','failed')),
  scheduled_at timestamptz,
  published_at timestamptz,
  external_post_id text,
  error_message text,
  created_at timestamptz default now()
);

create table socialbot_auto_reply_rules (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  keyword text not null,
  match_type text not null default 'both' check (match_type in ('comment','dm','both')),
  reply_template text not null,
  active boolean default true
);

create table socialbot_interactions_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  platform text not null,
  type text not null check (type in ('comment','dm')),
  external_id text not null,
  matched_keyword text,
  replied boolean default false,
  created_at timestamptz default now(),
  unique (platform, external_id)
);

alter table socialbot_agencies enable row level security;
alter table socialbot_clients enable row level security;
alter table socialbot_social_accounts enable row level security;
alter table socialbot_ai_settings enable row level security;
alter table socialbot_media_assets enable row level security;
alter table socialbot_schedule_slots enable row level security;
alter table socialbot_posts enable row level security;
alter table socialbot_auto_reply_rules enable row level security;
alter table socialbot_interactions_log enable row level security;

create policy "owner sees own agency" on socialbot_agencies
  for all using (owner_user_id = auth.uid());

create policy "owner sees own clients" on socialbot_clients
  for all using (agency_id in (select id from socialbot_agencies where owner_user_id = auth.uid()));

create policy "owner sees own social_accounts" on socialbot_social_accounts
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

create policy "owner sees own ai_settings" on socialbot_ai_settings
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

create policy "owner sees own media_assets" on socialbot_media_assets
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

create policy "owner sees own schedule_slots" on socialbot_schedule_slots
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

create policy "owner sees own posts" on socialbot_posts
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

create policy "owner sees own auto_reply_rules" on socialbot_auto_reply_rules
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

create policy "owner sees own interactions_log" on socialbot_interactions_log
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));
