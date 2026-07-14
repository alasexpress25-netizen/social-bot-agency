-- =========================================================
-- FASE 2: calificacion y guardado de leads
-- =========================================================
-- La misma llamada de IA de la Fase 1 (webhook meta-webhook) devuelve, ademas
-- de la respuesta al comentario/DM, si el contacto parece un lead caliente y
-- sus datos (nombre, contacto, interes). No suma costo extra de tokens: es
-- la misma llamada, solo que ahora le pedimos un JSON con ambas cosas.

create table if not exists socialbot_leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  platform text not null check (platform in ('facebook', 'instagram')),
  sender_id text not null,
  external_id text, -- comment_id o el id de mensaje que disparo la deteccion
  name text,
  contact text, -- telefono, email o usuario que haya compartido
  interest text, -- que producto/servicio le intereso, en pocas palabras
  source_text text, -- el mensaje original que disparo la deteccion (contexto para el humano que hace seguimiento)
  status text not null default 'nuevo' check (status in ('nuevo', 'contactado', 'convertido', 'descartado')),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (client_id, platform, sender_id)
);

alter table socialbot_leads enable row level security;

create policy "owner sees own leads" on socialbot_leads
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

-- Nota: no hace falta una policy aparte para service_role, igual que en el
-- resto de las tablas socialbot_* de 0001_init.sql -- el service_role usado
-- por el webhook y el scheduler bypassea RLS automaticamente en Supabase.
