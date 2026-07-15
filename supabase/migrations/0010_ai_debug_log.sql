-- =========================================================
-- Tabla temporal de diagnostico para ver, desde SQL, por que un intento de
-- respuesta con IA en el webhook no funciono (sin depender de los logs de
-- Supabase, que no siempre muestran el detalle del error). Solo
-- service_role escribe/lee (mismo patron que socialbot_ai_usage_log).
-- Se puede borrar mas adelante una vez que el flujo de IA este estable --
-- no es parte permanente del esquema, es una herramienta de debugging.
-- Ya aplicada en produccion (redaqqxoeciycqgjhpbv) directo via MCP de
-- Supabase. Este archivo es solo para que el repo quede fiel a lo que ya
-- esta corriendo.
-- =========================================================

create table if not exists socialbot_ai_debug_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid,
  stage text,
  detail text,
  created_at timestamptz default now()
);

alter table socialbot_ai_debug_log enable row level security;

create policy "service role full access ai_debug_log"
  on socialbot_ai_debug_log
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');
