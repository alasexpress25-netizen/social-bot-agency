-- Punto 8 de propuestas-30-07-2026.md (Fase 7.6 del roadmap propio): motor
-- de referidos. Cuando un lead pasa a 'convertido', se arma un mensaje
-- sugerido (reseña/referido) y se le avisa a la agencia -- nunca se manda
-- solo, requiere aprobación explícita desde el panel (pestaña Referidos).
--
-- NOTA: esta migración documenta lo que ya está aplicado en producción
-- (proyecto redaqqxoeciycqgjhpbv) pero faltaba en el repo. Reconstruida a
-- partir del estado real de la base -- si se vuelve a aplicar sobre la
-- misma base de prod, usar CREATE ... IF NOT EXISTS / OR REPLACE como ya
-- está abajo para que sea inofensivo.

create table if not exists socialbot_referral_suggestions (
  id uuid primary key default gen_random_uuid(),
  client_id uuid references socialbot_clients(id) on delete cascade not null,
  lead_id uuid references socialbot_leads(id) on delete cascade not null unique,
  platform text not null check (platform in ('facebook', 'instagram')),
  sender_id text not null,
  message text not null,
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'sent', 'failed')),
  send_error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  sent_at timestamptz
);

alter table socialbot_referral_suggestions enable row level security;

drop policy if exists "owner sees own referral suggestions" on socialbot_referral_suggestions;
create policy "owner sees own referral suggestions" on socialbot_referral_suggestions
  for all using (client_id in (
    select c.id from socialbot_clients c join socialbot_agencies a on a.id = c.agency_id where a.owner_user_id = auth.uid()
  ));

-- Arma la sugerencia apenas un lead pasa a 'convertido' (INSERT ya con ese
-- status, o UPDATE que lo cambia a ese status) y notifica a la agencia por
-- mail via la Edge Function notify-referral-suggestion (pg_net). El
-- on conflict (lead_id) do nothing evita duplicar la sugerencia si el lead
-- pasa por 'convertido' más de una vez.
create or replace function create_referral_suggestion()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_client_name text;
  v_place_id text;
  v_message text;
  v_new_id uuid;
begin
  if NEW.status = 'convertido' and (TG_OP = 'INSERT' or OLD.status is distinct from 'convertido') then
    select c.name, c.google_place_id into v_client_name, v_place_id
      from socialbot_clients c where c.id = NEW.client_id;

    v_message :=
      'Hola' || coalesce(' ' || NEW.name, '') || '! 🙌 Gracias por elegir' ||
      coalesce(' a ' || v_client_name, 'nos') ||
      '. Nos ayudaría muchísimo si nos dejás una reseña rápida contando tu experiencia' ||
      (case when v_place_id is not null
            then ': https://search.google.com/local/writereview?placeid=' || v_place_id
            else ' (contanos por acá mismo qué te pareció)'
       end) ||
      '. Y si conocés a alguien que también le pueda servir esto, ¡encantados de atenderlo también! 🙏';

    insert into socialbot_referral_suggestions (client_id, lead_id, platform, sender_id, message, status)
    values (NEW.client_id, NEW.id, NEW.platform, NEW.sender_id, v_message, 'proposed')
    on conflict (lead_id) do nothing
    returning id into v_new_id;

    if v_new_id is not null then
      perform net.http_post(
        url := 'https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/notify-referral-suggestion',
        headers := jsonb_build_object('Content-Type', 'application/json'),
        body := jsonb_build_object('suggestion_id', v_new_id)
      );
    end if;
  end if;

  return NEW;
end;
$function$;

drop trigger if exists trg_create_referral_suggestion on socialbot_leads;
create trigger trg_create_referral_suggestion
  after insert or update on socialbot_leads
  for each row execute function create_referral_suggestion();

-- Recién cuando la agencia aprueba la sugerencia (status -> 'approved')
-- se dispara el envío real via send-referral-prompt (pg_net). Si esa Edge
-- Function falla, ella misma vuelve a poner status='failed' -- y si la
-- agencia toca "Reintentar" (approved de nuevo desde failed), este mismo
-- trigger la vuelve a disparar porque OLD.status ('failed') es distinto
-- de 'approved'.
create or replace function send_referral_suggestion()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if NEW.status = 'approved' and OLD.status is distinct from 'approved' then
    perform net.http_post(
      url := 'https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/send-referral-prompt',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('suggestion_id', NEW.id)
    );
  end if;
  return NEW;
end;
$function$;

drop trigger if exists trg_send_referral_suggestion on socialbot_referral_suggestions;
create trigger trg_send_referral_suggestion
  after update on socialbot_referral_suggestions
  for each row execute function send_referral_suggestion();
