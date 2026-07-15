-- =========================================================
-- Base de conocimiento del negocio, por cliente. A diferencia de "topics"
-- (unas pocas palabras clave) y "tone" (un adjetivo corto), esto es un
-- texto largo tipo mini-README: servicios/productos con precios reales,
-- preguntas frecuentes, politicas (reembolsos, tiempos de entrega,
-- horarios de atencion), diferenciales -- lo que necesita la IA para
-- responder con precision, como si fuera el dueno del negocio, en vez de
-- improvisar. Se usa tanto al responder comentarios/DMs (meta-webhook)
-- como al generar el texto de los posts (post_scheduler.py).
-- Ya aplicada en produccion (redaqqxoeciycqgjhpbv) directo via MCP de
-- Supabase. Este archivo es solo para que el repo quede fiel a lo que ya
-- esta corriendo.
-- =========================================================

alter table socialbot_ai_settings
  add column if not exists knowledge_base text;
comment on column socialbot_ai_settings.knowledge_base is
  'Texto libre con info real del negocio (servicios, precios, FAQ, politicas). Se inyecta en el system prompt de la IA para que responda con precision.';
