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

### 6. Caso de éxito / one-pager automático
Con los números reales de un cliente (La Visual, Impacto3D) armar un
resumen presentable que Fede pueda mandar a un prospecto nuevo.

### 7. WhatsApp como canal
Hoy todo es Facebook/Instagram. En Argentina y Brasil buena parte de la
venta se cierra por WhatsApp. Es el salto de infraestructura más grande de
esta lista (WhatsApp Business API), pero probablemente el de mayor impacto
de valor para los clientes de la agencia a mediano plazo.

### 8. Reseñas de Google/Facebook monitoreadas
Mismo patrón que ya existe para comentarios: detectar reseña nueva,
sugerir/enviar respuesta.

---

## Menores / cuando haya tiempo

- Multi-usuario en la agencia (hoy `socialbot_agencies.owner_user_id` es
  un solo dueño — si Fede suma un empleado, no se puede loguear).
- Métrica de "tiempo de respuesta promedio" para mostrarle al cliente
  (prueba de velocidad = confianza).
- Vista de calendario visual para el plan de contenido semanal.

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
- Nota (18/07/2026): al revisar el repo para seguir con este documento, el
  ZIP que se subió no traía `notify-hot-lead`, `notify-stale-leads`, la
  migración `0019` ni el workflow `stale-leads-check.yml` que los items 1 y
  2 dicen tener implementados y en producción. Puede ser que ese trabajo se
  haya hecho directo en Supabase/GitHub y no se haya vuelto a bajar a este
  ZIP — vale la pena sincronizar el repo local con lo que está realmente
  en producción antes de seguir sumando cosas, para no perder ese trabajo
  ni pisarlo por accidente.
