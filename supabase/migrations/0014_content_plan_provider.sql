-- =========================================================
-- FASE 6 (parte 3): separa el provider de IA usado para el plan semanal de
-- contenido (content_planner.py) del que usan el webhook de comentarios/DMs
-- y el caption al momento de publicar (post_scheduler.py). Pedido por la
-- agencia el 15/07/2026 (ver README_ai_quota_separation_request.txt): un
-- cliente con mucho movimiento de comentarios puede agotar la cuota
-- gratuita de Groq antes de que corra el cron semanal del plan de
-- contenido, o al reves.
--
-- Con esta columna, un cliente puede tener por ejemplo comentarios en Groq
-- pero el plan semanal en OpenAI, sin que compitan por la misma cuota.
-- Default 'groq' para no romper clientes existentes.
--
-- Nota: content_planner.py y frontend/index.html (form "Configurar IA")
-- ya asumen que esta columna existe -- esta migracion es la que la crea.
--
-- Ya aplicada en producción (redaqqxoeciycqgjhpbv), 15/07/2026. Este
-- archivo es solo para que el repo quede fiel a lo que ya está corriendo
-- -- usa "if not exists", no cambia nada en la base real si ya se corrio.
-- =========================================================

alter table socialbot_ai_settings
  add column if not exists content_plan_provider text not null default 'groq'
    check (content_plan_provider in ('groq','openai','claude'));

comment on column socialbot_ai_settings.content_plan_provider is
  'Provider de IA (groq/openai/claude) usado SOLO para generar el plan semanal de contenido (content_planner.py, Fase 6). Independiente de "provider", que siguen usando el webhook de comentarios/DMs (meta-webhook) y el caption generado al momento de publicar (post_scheduler.py).';
