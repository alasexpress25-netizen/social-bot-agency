-- =========================================================
-- FASE 5 (cierre): la agencia YA podia aprobar/rechazar posts sin cambios
-- de RLS -- "owner sees own posts" (0001_init.sql) es "for all", incluye
-- UPDATE. Solo faltaba la UI en frontend/index.html (ver ese archivo).
-- Esta migracion agrega la notificacion por email al cliente cuando un
-- post queda pendiente de su aprobacion.
-- Ya aplicada en produccion (redaqqxoeciycqgjhpbv) directo via MCP de
-- Supabase. Este archivo es solo para que el repo quede fiel a lo que ya
-- esta corriendo.
-- =========================================================

create extension if not exists pg_net;

-- Se dispara despues de insertar un post nuevo. Si queda 'pending' (osea,
-- el cliente tiene require_approval=true), le pega a la Edge Function
-- notify-pending-post via pg_net (async, no bloquea el insert del
-- scheduler ni falla el post si el email no se puede mandar).
create or replace function public.notify_client_pending_post()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if NEW.approval_status = 'pending' and NEW.status = 'pending' then
    perform net.http_post(
      url := 'https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/notify-pending-post',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('post_id', NEW.id)
    );
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_notify_client_pending_post on socialbot_posts;
create trigger trg_notify_client_pending_post
  after insert on socialbot_posts
  for each row
  execute function public.notify_client_pending_post();
