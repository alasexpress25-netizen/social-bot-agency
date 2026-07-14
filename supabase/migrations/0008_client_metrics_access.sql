-- =========================================================
-- FASE 4: el cliente necesita poder LEER (no escribir) su propio
-- interactions_log para calcular la tasa de respuesta en su portal.
-- Hasta ahora esa tabla solo la veia la agencia (0001_init.sql).
-- Es SELECT-only: el cliente no tiene motivo para tocar esta tabla,
-- solo la agencia y el service_role (webhook) escriben ahi.
-- Ya aplicada en produccion (redaqqxoeciycqgjhpbv) directo via MCP de
-- Supabase. Este archivo es solo para que el repo quede fiel a lo que ya
-- esta corriendo.
-- =========================================================

create policy "client sees own interactions_log" on socialbot_interactions_log
  for select using (client_id in (
    select id from socialbot_clients where client_user_id = auth.uid()
  ));
