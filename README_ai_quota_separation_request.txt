PARCHE PARA README.md — agregar este item al Backlog (al final, junto con
los otros "más adelante, cuando haya 5+ clientes"), o como sub-item
colgando de la Fase 6 si se prefiere mantenerlo más visible ahí mismo.

--------------------------------------------------------------------------

* [ ] **Separar la cuota de IA del plan semanal (Fase 6) de la del webhook
  de comentarios/DMs (Fase 1).** Pedido por la agencia el 15/07/2026.

  Hoy los tres consumidores de IA del sistema pueden terminar compitiendo
  por la MISMA cuota gratuita de Groq (`GROQ_API_KEY`, un solo key, un
  solo free tier):
  1. `meta-webhook/index.ts` — responde comentarios/DMs (Fase 1), usa Groq
     siempre, sin importar el `provider` configurado por cliente.
  2. `post_scheduler.py` (`generate_caption`) — redacta el caption en el
     momento de publicar, si el cliente tiene `provider='groq'`.
  3. `content_planner.py` (Fase 6, nuevo) — arma el plan semanal completo,
     también con `provider='groq'` si el cliente lo tiene así configurado.

  Un cliente con mucho movimiento de comentarios puede agotar la cuota
  diaria de Groq antes de que corra el cron semanal del plan de contenido
  (o al revés, si el plan semanal genera 5-7 posts de una sola vez con
  prompts largos, puede comerse buena parte de la cuota del día justo
  antes de que el webhook la necesite).

  **Cómo se resolvería** (a implementar):
  * Nueva columna `socialbot_ai_settings.content_plan_provider` (groq /
    openai / claude, default `groq`), independiente de `provider` (que
    sigue siendo el que usan el webhook y el caption del momento de
    publicar). Así cada cliente puede tener, por ejemplo, comentarios en
    Groq pero el plan semanal en OpenAI, sin que se pisen.
  * Si el cliente deja `content_plan_provider` en `groq`, usar una API key
    de Groq DISTINTA a la del webhook (`GROQ_API_KEY_CONTENT_PLAN` como
    secret nuevo en GitHub Actions, separado de `GROQ_API_KEY`) — Groq
    permite crear varias API keys gratuitas sobre la misma cuenta, cada
    una con su propio cupo, así que alcanza con generar una segunda key
    en el dashboard de Groq y cargarla como secret nuevo, sin costo extra.
  * `frontend/index.html`: agregar el selector de `content_plan_provider`
    en el mismo `<details>` de "Configurar IA (${ai.provider})", al lado
    del selector de `provider` que ya existe.
  * Archivos a tocar: `supabase/migrations/00XX_content_plan_provider.sql`,
    `scheduler/content_planner.py` (leer `content_plan_provider` y la key
    separada), `.github/workflows/content_planner.yml` (nuevo secret),
    `frontend/index.html`.

--------------------------------------------------------------------------
