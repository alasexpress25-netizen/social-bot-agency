-- =========================================================
-- PRIORIDAD 1, punto 1 del roadmap (PROPUESTAS-AGENCIA.md): alerta
-- inmediata cuando se guarda (o se actualiza) un lead en etapa
-- "listo_para_comprar" -- le pega a la Edge Function notify-hot-lead via
-- pg_net, mismo patron que notify-pending-post (0009).
--
-- Ya aplicada en producción (redaqqxoeciycqgjhpbv), migración
-- "notify_hot_lead" (20260717210527). Este archivo es solo para que el
-- repo quede fiel a lo que ya está corriendo -- bajado tal cual de
-- producción via MCP de Supabase (18/07/2026), no hace falta volver a
-- aplicarlo en ese proyecto.
-- =========================================================

create or replace function public.notify_agency_hot_lead()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_hot_now boolean;
  was_hot_before boolean;
begin
  is_hot_now := (NEW.interest ilike '[listo_para_comprar]%');

  if TG_OP = 'INSERT' then
    was_hot_before := false;
  else
    was_hot_before := (OLD.interest ilike '[listo_para_comprar]%');
  end if;

  if is_hot_now and not was_hot_before then
    perform net.http_post(
      url := 'https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/notify-hot-lead',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('lead_id', NEW.id)
    );
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_notify_agency_hot_lead on socialbot_leads;
create trigger trg_notify_agency_hot_lead
  after insert or update on socialbot_leads
  for each row
  execute function public.notify_agency_hot_lead();
