# Propuestas de mejora — social-bot-agency

Mapa de qué ya existe, qué falta, y en qué orden conviene sumarlo. Pensado
para tres objetivos: **mejor atención** (responder rápido, no perder leads),
**mejor trabajo** (menos tareas manuales para Fede) y **más clientes**
(retención de los actuales + argumentos para conseguir nuevos).

Estado al 17/07/2026. Se va tildando a medida que se implementa.

---

## 🟢 Ya construido (para no reinventar)

- Auto-respuesta con IA (Groq) en comentarios y DMs, con cache, límite
  diario por cliente y 3 niveles de fallback (IA → keyword → plantilla fija).
- Detección de leads con etapa del embudo (`interesado` / `potencial` /
  `listo_para_comprar` / `cliente_existente`), con red de seguridad
  heurística cuando la IA no responde.
- Link clickeable al post/comentario de origen de cada lead (`post_permalink`).
- Portal de cliente read-only (`cliente.html`): métricas, posts, leads con
  el estado que fija la agencia.
- Aprobación manual de posts por el cliente antes de publicar
  (`require_approval`), con email de aviso (`notify-pending-post`).
- Planificación semanal de contenido generada por IA
  (`socialbot_content_plan_items`), editable y aprobable.
- Métricas de posts publicados (likes) y gráficos semanales/mensuales.
- Idioma de respuesta configurable por cliente (`pt-BR` / `es` / `auto`).

---

## 🥇 Prioridad 1 — Impacto directo en conversión

### 1. Alerta inmediata de lead "listo para comprar" ✅ HECHO (17/07/2026)
Hoy un lead se guarda igual sea `interesado` o `listo_para_comprar` — nadie
se entera hasta que alguien entra al panel. Un lead que quiere comprar YA y
tarda en ser contactado es plata perdida. Se agrega: trigger en
`socialbot_leads` que, apenas se guarda un lead en etapa
`listo_para_comprar`, dispara un email inmediato a la agencia (mismo patrón
que `notify-pending-post`, con `pg_net` + Edge Function).

**Implementado:** Edge Function `notify-hot-lead` + trigger
`trg_notify_agency_hot_lead` (migración `0019_notify_hot_lead.sql`), ambos
deployados y activos en producción. Falta cargar los secrets SMTP en la
función (ver sección de notas técnicas).

### 2. Aviso de leads "nuevo" sin contactar hace más de X horas ✅ HECHO (17/07/2026)
Para las etapas `potencial` / `interesado`, que no ameritan alarma
inmediata pero sí seguimiento. Un chequeo periódico (cron) que arma un
resumen ("tenés 4 leads sin contactar hace más de 24hs") y lo manda por
email — mismo mecanismo que ya usa `recupero-leads` para su propio caso.

**Implementado:** Edge Function `notify-stale-leads` (deployada, corre por
HTTP, sin trigger de Postgres) + workflow de GitHub Actions
`.github/workflows/stale-leads-check.yml` que la dispara todos los días a
las 09:00 (Argentina/Brasil). Umbral configurable via secret `STALE_HOURS`
(default 24hs). Falta: subir el workflow al repo de GitHub y cargar los
secrets SMTP en la función.

---

## 🥈 Prioridad 2 — Retener a los clientes actuales

### 3. Reporte mensual automático por cliente ✅ HECHO (18/07/2026)
Ya está todo el dato (`renderMetrics`): consultas recibidas, conversiones,
likes. Armar un email/PDF mensual automático por cliente con ese resumen
es lo que justifica la factura sin que Fede tenga que armarlo a mano cada
mes — y es un lindo argumento de venta para clientes nuevos también.

**Implementado:** `scheduler/monthly_report.py` + workflow de GitHub
Actions `.github/workflows/monthly_report.yml`, que corre el día 1 de cada
mes a las 09:00 (Argentina/Brasil) y manda un email de texto (consultas
recibidas, clientes convertidos, publicaciones, me gusta) a cada cliente
con `client_email` cargado, en su `reply_language` (es/pt-BR). Falta:
subir el workflow al repo de GitHub y cargar los secrets SMTP (mismos
nombres que ya usa `notify-pending-post`) + opcionalmente
`CLIENT_PORTAL_URL` en GitHub Secrets (Settings → Secrets and variables →
Actions), no en Supabase — este cron corre en GitHub Actions, no como Edge
Function.

### 4. Alerta de cliente "en riesgo" (inactividad) ✅ HECHO (18/07/2026)
Si un cliente lleva 2+ semanas sin posts publicados o sin leads nuevos,
avisarle a Fede antes de que el cliente se queje o se dé de baja. Consulta
simple contra `socialbot_posts.published_at` / `socialbot_leads.created_at`.

**Implementado:** `scheduler/inactive_clients_alert.py` + workflow
`.github/workflows/inactive_clients_alert.yml`, corre todos los lunes a
las 09:00. Umbral configurable via secret `INACTIVITY_DAYS` (default 14
días). Agrupa por agencia y le manda un solo email al owner con la lista
de clientes en riesgo. Mismos secrets SMTP que el punto 3. Falta: subir el
workflow al repo y cargar los secrets.

### 5. Export CSV de leads ✅ HECHO (18/07/2026)
Para que el cliente pueda bajar sus leads y usarlos en su propio CRM/Excel.
Bajo esfuerzo, alto valor percibido — un botón más en `cliente.html`.

**Implementado:** botón "Exportar CSV" en la sección de contactos
interesados de `cliente.html`, 100% client-side (no pega contra Supabase
de nuevo, usa los leads ya cargados) — no requiere ningún secret ni
deploy de backend, ya está listo para usar apenas se suba el archivo.

---

## 🥉 Prioridad 3 — Crecimiento de la agencia

### 6. Caso de éxito / one-pager automático ✅ HECHO (18/07/2026)
Con los números reales de un cliente (La Visual, Impacto3D) armar un
resumen presentable que Fede pueda mandar a un prospecto nuevo.

**Implementado:** `scheduler/success_story_generator.py`, herramienta de
línea de comandos (no corre por cron, se dispara a mano cuando hace
falta): `python scheduler/success_story_generator.py <client_id> [--days
90] [--anon]`. Junta consultas recibidas, clientes convertidos, tasa de
conversión, posts publicados, me gusta, tasa de respuesta automática y
tiempo de respuesta promedio de los últimos N días, y arma un one-pager en
HTML en `scheduler/output/caso-exito-<client_id>.html`, listo para abrir
en el navegador y convertir a PDF ("Imprimir → Guardar como PDF") o mandar
tal cual. `--anon` reemplaza el nombre real del cliente por "un cliente
real de la agencia", para poder mostrárselo a otros prospectos sin
exponer a quién pertenecen los números.

### 7. WhatsApp como canal — 🕓 EN PAUSA, para más adelante
Hoy todo es Facebook/Instagram. En Argentina y Brasil buena parte de la
venta se cierra por WhatsApp. Es el salto de infraestructura más grande de
esta lista (WhatsApp Business API), pero probablemente el de mayor impacto
de valor para los clientes de la agencia a mediano plazo. Se deja anotado
para retomar más adelante, sin trabajo iniciado todavía.

### 8. Reseñas de Google/Facebook monitoreadas ✅ HECHO (18/07/2026)
Mismo patrón que ya existe para comentarios: detectar reseña nueva,
sugerir/enviar respuesta.

**Implementado:** migración `0020_reviews.sql` (tabla `socialbot_reviews`
+ columna `google_place_id` en `socialbot_clients`) + `scheduler/reviews_monitor.py`
+ workflow `.github/workflows/reviews_monitor.yml`, que corre cada 6
horas. Para Facebook usa el mismo `page_access_token` que ya tiene cada
cuenta conectada (endpoint `/ratings` de Graph API). Para Google usa Place
Details de la Places API contra el `google_place_id` que la agencia carga
desde el modal "Editar cliente" (ya en el frontend). Cada reseña nueva
guarda una respuesta sugerida generada por IA (mismo provider/tono que ya
tiene configurado el cliente, con fallback a una plantilla fija si no hay
IA configurada). La UI para revisar, copiar la sugerencia y marcar estado
ya está en `frontend/index.html` (sección "⭐ Reseñas"). Falta: subir el
workflow al repo, cargar el secret nuevo `GOOGLE_PLACES_API_KEY` (los de
IA ya existen) y aplicar la migración `0020` en producción.

---

## 🆕 Propuestas nuevas (18/07/2026) — sin tocar multitenant ni WhatsApp

Salen de revisar el repo completo buscando huecos concretos, no genéricos.
En orden de impacto:

### 9. Quitado

### 10. Escalamiento de comentarios negativos/quejas
El prompt de `meta-webhook` ya le dice a la IA que NO marque como lead una
"queja sin relación al negocio" (correcto), pero no hay ningún camino para
esas quejas: hoy se autoresponde con tono genérico (o no se responde) y
nadie de la agencia se entera. Para reseñas negativas sí existe ese
cuidado (`reviews_monitor.py` detecta `is_negative` y ajusta el tono de la
sugerencia) — falta el mismo criterio para comentarios. Detectar
sentimiento negativo en el mismo llamado de IA que ya se hace, y en vez de
autoresponder, guardar en una cola de "requiere atención humana" +
notificación (mismo patrón que `notify-hot-lead`).

### 11. Anti-spam por remitente repetido ✅ HECHO (18/07/2026)
El límite diario de IA (`daily_ai_reply_limit`) es por cliente, no por
persona. Si un mismo `sender_id` comenta varias veces seguidas (spam,
insistencia, alguien probando el sistema), cada comentario consume cupo
del límite diario del cliente y puede vaciarlo antes de que lleguen leads
reales. Chequeo simple: mismo `sender_id` + más de N respuestas en la
última hora → no autoresponder más, solo loguear.

**Implementado:** migración `0024_antispam_sender_id.sql` agrega
`sender_id` a `socialbot_interactions_log` (antes solo se guardaba el id
del comentario/mensaje, no quién lo mandó) + `anti_spam_hourly_limit`
opcional en `socialbot_ai_settings` para ajustar el umbral por cliente
(default en el código: 5 por hora si la columna queda en `null`).
`meta-webhook/index.ts` suma `isSenderSpamming()`: se chequea justo después
de reservar la interacción (`claimInteraction`, que ahora también guarda el
`sender_id`) y antes de intentar cualquier respuesta (IA, keyword o
fallback) — si el remitente superó el límite en la última hora, se corta
ahí mismo, se marca la interacción como `anti-spam-limite` en el log y no
se manda ninguna respuesta ni se guarda lead. De paso se corrigió un bug
preexistente en el archivo: a `tryAiReply` le faltaba la firma completa de
la función (quedaba solo el tipo de retorno), lo que hubiera roto el
deploy. **Ya deployado y aplicado en producción** (redaqqxoeciycqgjhpbv,
18/07/2026): migración `0024` corrida vía MCP de Supabase y
`meta-webhook` re-deployado (v26) con la lógica de anti-spam activa. Nada
pendiente de este lado.

### 12. Recordatorio de posts pendientes de aprobación ✅ HECHO (18/07/2026)
Si el cliente no aprueba/rechaza un post en X horas, un segundo email de
seguimiento — mismo patrón que `notify-pending-post`, pero disparado por
tiempo transcurrido en vez de por la creación del post.

**Implementado:** al revisar producción para deployar esto encontré que
**ya estaba hecho** — en otra sesión que no había quedado bajada a este
ZIP (mismo patrón de desincronización que ya señala la nota técnica al pie
de este documento). Ya existen en producción (redaqqxoeciycqgjhpbv):
migración `pending_post_reminder` (columna `approval_reminder_sent_at` en
`socialbot_posts`, evita mandar el recordatorio más de una vez por post) +
Edge Function `remind-pending-post` (deployada y activa, default de 24hs).
Funciona igual que lo descrito arriba: chequeo periódico por tiempo
transcurrido, mismo patrón que `notify-stale-leads`. Sincronicé el repo
local para que quede fiel a esto (`supabase/migrations/0023_pending_post_reminder.sql`
+ `supabase/functions/remind-pending-post/index.ts`, con el código exacto
que está corriendo). Falta solo: subir
`.github/workflows/pending_post_reminder.yml` al repo de GitHub — no
encontré rastro de que ese cron ya exista ahí, así que puede estar
corriendo manual o no estar corriendo del todo; conviene chequearlo antes
de asumir que ya está automatizado.

### 13. Mejor horario de publicación sugerido
Ya existe `likes` por post con `published_at` en `socialbot_post_metrics`.
Cruzando eso se le puede sugerir a `content_planner.py` a qué hora del día
y qué día de la semana conviene programar, en vez de usar siempre los
horarios fijos de `socialbot_schedule_slots`.

---

## Menores / cuando haya tiempo

- Métrica de "tiempo de respuesta promedio" para mostrarle al cliente
  (prueba de velocidad = confianza). ✅ HECHO (18/07/2026): migración
  `0021_response_time.sql` agrega `replied_at` a
  `socialbot_interactions_log`; `supabase/functions/meta-webhook/index.ts`
  ya la setea al contestar. Falta aplicar el parche de frontend descrito
  en `response_time_kpi_patch_instructions.txt` para mostrar el KPI en el
  panel (no se tocó `frontend/index.html` directamente para no arriesgar
  pisar la versión que ya tenés con reseñas/calendario).
- Vista de calendario visual para el plan de contenido semanal — ya
  implementada en tu `frontend/index.html` actual (toggle 📋 Lista / 📅
  Calendario en la sección del plan semanal).

---

## Notas técnicas para lo que se vaya sumando

- El patrón de notificación por email ya está resuelto y probado
  (`notify-pending-post`): trigger Postgres + `pg_net` → Edge Function con
  `denomailer` sobre el SMTP de Hostinger. Reutilizar ese patrón para todo
  lo nuevo de este documento evita inventar un mecanismo distinto cada vez.
- Los secrets de SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`,
  `SMTP_FROM`) están seteados a nivel de cada Edge Function individualmente
  en Supabase — cada función nueva que mande email los necesita propios.
- Para los items 3 y 4 (chequeos batch, no eventos por fila) se usó el
  patrón que ya tenía el repo para este tipo de tarea: script Python +
  GitHub Actions cron pegando directo contra la REST API de Supabase
  (`scheduler/post_scheduler.py`, `scheduler/content_planner.py`), en vez
  de Edge Function + pg_net (que es el patrón para triggers por fila, como
  `notify-pending-post`). Ahí los secrets SMTP van en GitHub, no en
  Supabase.
- Secrets nuevos sumados por los items 6 y 8: `GOOGLE_PLACES_API_KEY`
  (GitHub Secrets, opcional — sin él, `reviews_monitor.py` solo chequea
  Facebook) y ninguno para `success_story_generator.py`, que corre a mano
  con las mismas `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` de siempre.
- Nota (18/07/2026): al revisar el repo para seguir con este documento, el
  ZIP que se subió no traía `notify-hot-lead`, `notify-stale-leads`, la
  migración `0019` ni el workflow `stale-leads-check.yml` que los items 1 y
  2 dicen tener implementados y en producción. Puede ser que ese trabajo se
  haya hecho directo en Supabase/GitHub y no se haya vuelto a bajar a este
  ZIP — vale la pena sincronizar el repo local con lo que está realmente
  en producción antes de seguir sumando cosas, para no perder ese trabajo
  ni pisarlo por accidente.
- Nota (18/07/2026, actualización): el `frontend/index.html` del ZIP
  también estaba desactualizado respecto a lo publicado en Hostinger —
  faltaban el selector de cliente de arriba del dash, los modals de
  "nuevo/editar cliente", el campo de Google Place ID, "Publicar ahora" y
  "Enviar resumen ahora". El parche del KPI de tiempo de respuesta se
  volvió a aplicar sobre la versión real (la de Hostinger), no sobre la
  del ZIP. Conviene bajar del hosting el `index.html` real y subirlo al
  repo antes de seguir iterando, para evitar volver a pisar trabajo por
  trabajar sobre una copia vieja.
