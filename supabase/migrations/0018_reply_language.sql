-- =========================================================
-- Idioma de respuesta de la IA en el meta-webhook, por cliente. Hasta ahora
-- estaba fijo en portugues de Brasil para TODOS los clientes (tenia sentido
-- cuando el unico cliente con IA activa era Impacto 3D, 100% Brasil).
--
-- Valores soportados:
--   'pt-BR' -> siempre responde en portugues de Brasil (default, sin
--              cambios de comportamiento para clientes ya configurados).
--   'es'    -> siempre responde en español.
--   'auto'  -> la IA detecta el idioma del mensaje entrante y responde en
--              ese mismo idioma (pensado para clientes bilingues).
--
-- NOTA (16/07/2026): se probo 'auto' con Alas Tecno (Argentina/Brasil) pero
-- la IA empezo a confundirse, asi que ese cliente quedo fijo en 'pt-BR'
-- igual que Impacto 3D. El campo y la logica quedan disponibles por si se
-- retoma el modo bilingue mas adelante con otro enfoque.
--
-- Ya aplicada en produccion (redaqqxoeciycqgjhpbv) directo via MCP de
-- Supabase. Este archivo es solo para que el repo quede fiel a lo que ya
-- esta corriendo.
-- =========================================================

alter table socialbot_ai_settings
  add column if not exists reply_language text not null default 'pt-BR';

comment on column socialbot_ai_settings.reply_language is
  'Idioma de las respuestas automaticas del meta-webhook. "pt-BR" o "es" fuerzan ese idioma siempre; "auto" hace que la IA detecte y responda en el mismo idioma del comentario/DM entrante (para clientes bilingues).';
