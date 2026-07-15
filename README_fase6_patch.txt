PARCHE PARA README.md — reemplazar TODO el bloque de "Fase 6" (desde
"* [ ] **Fase 6 —" hasta justo antes de "### Backlog") por el texto de
abajo. Cambia el estado a [x] y documenta lo que realmente se construyó
(que es más de lo planeado originalmente: no son solo "ideas sueltas",
sino posts ya redactados y con criterio de performance real).

--------------------------------------------------------------------------

* [x] **Fase 6 — Plan semanal de contenido con IA, basado en performance real.**
  Se implementó con más alcance del que se había planeado originalmente:
  en vez de solo sugerir temas sueltos, la IA arma un lote de posts YA
  REDACTADOS para la semana (uno por cada día que el cliente publica),
  usando como criterio real qué funcionó antes — no solo `topics`/`tone`.

  **Qué mira la IA antes de proponer:**
  * Métricas de cada post publicado (likes, comentarios, shares, alcance),
    traídas de Meta Graph API por `post_scheduler.py` en cada corrida y
    guardadas en `socialbot_post_metrics` — antes esto no se guardaba en
    ningún lado, solo se sabía *que* se había publicado, no *cómo le fue*.
  * Los 3 posts que mejor engancharon y los 3 que peor, de los últimos 30
    días (con su texto y sus números), para repetir ángulo/formato de lo
    que funciona y evitar lo que no.
  * El interés de los últimos `socialbot_leads` (qué pregunta la gente de
    verdad) y los últimos ~15 captions publicados (para no repetir gancho).
  * Cuántos días por semana publica el cliente (`socialbot_schedule_slots`
    activos), para saber cuántas ideas generar.

  **Flujo:**
  1. Cron nuevo, todos los lunes (`content_planner.py`, disparable también
     a mano): genera el lote y lo guarda en `socialbot_content_plan_items`
     con `status='proposed'`. Si ya existe un plan para esa semana, no
     genera uno nuevo (evita duplicar si el cron corre dos veces).
  2. La agencia lo revisa desde su panel (sección nueva "📅 Plan semanal de
     contenido"), puede editar el texto, y aprueba o rechaza cada idea.
  3. Un item **aprobado** queda reservado para su `target_date`: el día que
     corresponde, `post_scheduler.py` lo detecta automáticamente y usa ese
     texto tal cual para generar el post (sin volver a pasar por la IA en
     el momento), y lo marca `used`. Si nadie lo aprueba antes de esa
     fecha, el scheduler sigue con su lógica de siempre (caption_override
     del media, o generación en el momento) — no rompe nada si la agencia
     no llega a revisarlo.

  **Seguridad / alcance de esta primera versión:** por ahora solo la
  agencia puede aprobar/editar el plan (mismo patrón de RLS `for all` que
  ya tenía sobre `socialbot_posts`, sin necesitar RPC nueva). El cliente
  puede *ver* su propio plan (policy de solo lectura) pero no actuar sobre
  él todavía — si más adelante se quiere que también opine/apruebe desde
  su portal, se agrega siguiendo el mismo patrón de funciones RPC
  `SECURITY DEFINER` que ya usa el resto de acciones de cliente (ver
  `0006_client_portal.sql`).

  *Archivos: `supabase/migrations/0012_post_metrics.sql`,
  `supabase/migrations/0013_content_plan.sql`, `scheduler/post_scheduler.py`
  (recolección de métricas + uso del plan aprobado),
  `scheduler/content_planner.py` (nuevo),
  `.github/workflows/content_planner.yml` (nuevo, cron semanal),
  `frontend/index.html` (sección "Plan semanal de contenido" por cliente).*

  **⏳ Todavía no aplicado en producción.** A diferencia del resto de este
  README, esta fase se escribió en este chat y falta: correr las 2
  migraciones nuevas contra `redaqqxoeciycqgjhpbv` (vía MCP de Supabase o
  SQL editor), subir los 3 archivos de `scheduler/` y `.github/workflows/`
  al repo, y aplicar el parche de `frontend/index.html` (ver
  `frontend/index_html_patch_instructions.txt`). El GitHub Actions
  conector todavía no está habilitado del lado del chat, así que por ahora
  el traspaso es manual, igual que se hizo con la carpeta inicial del
  proyecto.

--------------------------------------------------------------------------
