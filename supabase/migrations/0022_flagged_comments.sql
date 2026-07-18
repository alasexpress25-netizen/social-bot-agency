-- =========================================================
-- Propuesta 10 (PROPUESTAS-AGENCIA.md, 18/07/2026): escalamiento de
-- comentarios negativos/quejas. Hasta ahora meta-webhook detectaba una
-- "queja sin relacion al negocio" solo para NO marcarla como lead
-- (correcto), pero no habia ningun camino para esas quejas: se
-- autorespondia con tono generico (o no se respondia) y nadie de la
-- agencia se enteraba. Mismo criterio que ya existe para reseñas
-- negativas (reviews_monitor.py / is_negative), ahora tambien para
-- comentarios entrantes.
--
-- socialbot_flagged_comments es la cola de "requiere atencion humana":
-- meta-webhook guarda aca (en vez de autoresponder) cualquier comentario
-- que la IA detecte con sentiment negativo, y dispara una notificacion a
-- la agencia via el mismo patron pg_net -> Edge Function que ya usa
-- notify-hot-lead (0019_notify_hot_lead.sql).
-- =========================================================

create table if not exists socialbot_flagged_comments (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  platform text not null check (platform in ('facebook', 'instagram')),
  external_id text not null, -- comment_id de Meta
  sender_id text,
  text text not null,
  reason text, -- breve motivo que dio la IA (ej: "se queja de una demora en la entrega")
  status text not null default 'pendiente' check (status in ('pendiente', 'resuelto')),
  created_at timestamptz default now(),
  resolved_at timestamptz,
  unique (platform, external_id)
);

alter table socialbot_flagged_comments enable row level security;

create policy "owner sees own flagged_comments" on socialbot_flagged_comments
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

-- service_role (meta-webhook) escribe estas filas directo, bypassea RLS
-- igual que el resto de las tablas socialbot_*.

create index if not exists idx_flagged_comments_client_status
  on socialbot_flagged_comments (client_id, status);

-- ---------------------------------------------------------------------
-- Trigger de notificacion, mismo patron que trg_notify_agency_hot_lead
-- (0019_notify_hot_lead.sql): solo dispara en el INSERT (una queja nueva
-- entra siempre en 'pendiente'; no hace falta comparar contra el estado
-- anterior como en el trigger de leads porque esta tabla no se actualiza
-- para cambiar de "no pendiente" a "pendiente").
--
-- IMPORTANTE: reemplazar 'https://TU-PROYECTO.supabase.co' por la URL real
-- del proyecto antes de aplicar (mismo placeholder que ya usan las demas
-- migraciones de este repo que no vienen bajadas de produccion).
-- ---------------------------------------------------------------------
create or replace function public.notify_agency_flagged_comment()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://TU-PROYECTO.supabase.co/functions/v1/notify-flagged-comment',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object('flagged_comment_id', NEW.id)
  );
  return NEW;
end;
$$;

drop trigger if exists trg_notify_agency_flagged_comment on socialbot_flagged_comments;
create trigger trg_notify_agency_flagged_comment
  after insert on socialbot_flagged_comments
  for each row
  execute function public.notify_agency_flagged_comment();
