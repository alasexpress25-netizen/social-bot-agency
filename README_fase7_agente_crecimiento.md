# Fase 7 — Agente de Crecimiento (propuesta)

> Este documento describe una fase **nueva**, todavía no implementada. Sigue el
> mismo formato que el resto del roadmap del proyecto (ver `README.md`,
> sección Fases). No reemplaza nada de lo ya construido — se apoya 100% en
> datos que el sistema ya guarda desde las Fases 1 a 6.

## Por qué esta fase

Hoy el sistema **publica** y **responde** solo. Toda la inteligencia que
genera (métricas de posts, leads calificados, tasa de respuesta, plan
semanal de contenido) vive en tablas que la agencia tiene que ir a mirar
activamente en el panel. Nadie actúa *proactivamente* sobre esos datos: si
un lead lleva 10 días sin contactar, o un cliente lleva 3 semanas sin
publicar nada con buen engagement, el sistema no avisa — hay que
descubrirlo a mano.

El objetivo de esta fase es cerrar ese círculo: que el propio bot detecte
señales de oportunidad o riesgo y actúe (avisando, proponiendo, o generando
contenido) sin que la agencia tenga que pedírselo. Dos frentes:

1. **Crecer a cada cliente de la agencia** (más leads convertidos, más
   contenido que funciona, menos oportunidades perdidas).
2. **Crecer a la agencia misma** (marketing propio con datos reales, y
   evidencia lista para justificar renovaciones/upsells).

## Qué ya existe y en qué se apoya cada pieza

| Dato que ya se guarda | Tabla | Desde qué fase |
|---|---|---|
| Leads calificados con estado | `socialbot_leads` | Fase 2 |
| Métricas por post (likes/comments/shares) | `socialbot_post_metrics` | Fase 6 |
| Plan semanal de contenido con ángulo/justificación | `socialbot_content_plan_items` | Fase 6 |
| Tasa de respuesta automática | `socialbot_interactions_log` | Fase 1 |
| Historial de publicaciones | `socialbot_posts` | Fase inicial |

Todo lo de abajo son **consumidores nuevos** de esos datos, no fuentes
nuevas de datos (salvo donde se aclara lo contrario).

---

## 7.1 — Detector de leads fríos (prioridad alta, bajo esfuerzo)

**Problema:** un lead queda en `status='nuevo'` indefinidamente si nadie lo
mira. Hoy no hay ningún mecanismo de recordatorio.

**Solución:** un cron diario (`scheduler/stale_leads_alert.py`) que:
1. Busca leads con `status='nuevo'` y `created_at` de hace más de N días
   (configurable, default 3).
2. Agrupa por cliente y arma un resumen.
3. Manda un email a la agencia (reusa el mismo patrón SMTP de
   `notify-pending-post`) con la lista: nombre, contacto, interés, cuántos
   días esperando.

**Archivos nuevos:**
- `scheduler/stale_leads_alert.py`
- `.github/workflows/stale_leads_alert.yml` (cron diario, ej. 08:00 local)
- Sin migración nueva — reusa `socialbot_leads` tal cual.

**Por qué primero:** es el de menor esfuerzo (no toca IA, no toca Meta
Graph API) y el de mayor impacto inmediato en conversión — un lead
calificado sin seguimiento es la pérdida más evitable de todo el sistema.

---

## 7.2 — Alerta de bajón de contenido/engagement

**Problema:** `bucketByWeek` ya calcula posts-por-semana y engagement en el
frontend, pero solo se ve si alguien entra al panel a mirarlo.

**Solución:** extender `content_planner.py` (que ya corre semanalmente y
ya calcula `posts_last_30_days` y el ranking de `top_posts`/`bottom_posts`
por cliente) para que, además de generar el plan, evalúe una condición
simple:
- Si `posts_last_30_days == 0` **o** el promedio de score de los últimos
  posts cayó más de X% vs. el período anterior → agregar una línea al
  mismo email/resumen semanal que ya se podría mandar cuando se genera el
  plan (ver `notify-pending-post` como referencia de infraestructura SMTP
  ya lista para reusar).

**Archivos a tocar:**
- `scheduler/content_planner.py` (agregar el chequeo, sin migración nueva)
- Reusa el mismo mecanismo de email que 7.1, para no duplicar
  infraestructura SMTP.

---

## 7.3 — A/B de ángulos en el plan semanal

**Problema:** `content_planner.py` genera **una** idea por día. Si el
ángulo no pega, se pierde esa fecha.

**Solución:** pedirle a la IA 2 variantes por día (mismo contexto, mismo
prompt — no cuesta una llamada extra, se pide en el mismo JSON) y que la
agencia elija cuál aprobar desde el panel.

**Cambios:**
- `content_planner.py`: el JSON de respuesta pasa de `{"ideas": [...]}` a
  que cada `day_offset` tenga un array `variants: [{angle, caption}, {angle, caption}]`.
- `socialbot_content_plan_items`: agregar columna `variant_index int
  default 0` (o crear una fila por variante con el mismo `target_date` y
  dejar que aprobar una rechace automáticamente a la otra vía trigger).
- `frontend/index.html`: mostrar ambas variantes lado a lado en el mismo
  `<details>` del plan semanal.

**Migración nueva:** `00XX_content_plan_variants.sql`.

---

## 7.4 — Casos de éxito automáticos (crecimiento de la agencia)

**Problema:** la agencia tiene evidencia real de que el sistema funciona
(`top_posts` con métricas fuertes) pero no la usa para conseguir clientes
nuevos.

**Solución:** un cron mensual (`scheduler/success_story_generator.py`) que:
1. Recorre clientes activos, busca el post con mejor score de los últimos
   30 días (mismo cálculo que ya usa `build_context()` en
   `content_planner.py` — se puede importar/duplicar esa función).
2. Si supera un umbral mínimo (para no generar "casos de éxito" de un post
   que tuvo 3 likes), le pide a la IA un texto tipo "cómo ayudamos a un
   negocio de [rubro] a lograr X" — **anonimizado** (sin nombre del
   cliente ni datos identificables, salvo que la agencia habilite
   explícitamente mostrarlo).
3. Lo guarda como `proposed` en una tabla nueva
   `socialbot_agency_content_ideas` (mismo patrón que
   `socialbot_content_plan_items`, pero para las redes propias de la
   agencia, no de un cliente).
4. La agencia lo revisa/edita/publica manualmente en sus propias redes (no
   se auto-publica — esto es marketing de la agencia, con más
   sensibilidad que el contenido de un cliente).

**Archivos nuevos:**
- `supabase/migrations/00XX_agency_content_ideas.sql`
- `scheduler/success_story_generator.py`
- `.github/workflows/success_story_generator.yml` (cron mensual)
- `frontend/index.html`: sección nueva a nivel agencia (no por cliente)

**Consideración de privacidad:** por default, el caso de éxito **no**
menciona el nombre del cliente ni el rubro exacto si el cliente no dio
consentimiento explícito. Se recomienda agregar un campo
`allow_case_study boolean default false` en `socialbot_clients`, visible
solo para la agencia, que el cliente podría autorizar desde su portal más
adelante (mismo patrón de opt-in que `require_approval`).

---

## 7.5 — Reporte mensual de ROI por cliente

**Problema:** justificar la renovación o un upsell hoy depende de que la
agencia entre al panel y arme el argumento a mano.

**Solución:** un cron mensual que arma, por cliente, un resumen (leads
generados, posts publicados, tasa de respuesta, mejor post del mes — todo
data que **ya existe**, mismo cálculo que `bucketByWeek` en el frontend
pero corrido server-side) y lo manda por email a la agencia (y
opcionalmente al cliente, si se quiere transparencia total).

**Archivos:**
- `scheduler/monthly_roi_report.py`
- `.github/workflows/monthly_roi_report.yml`
- Sin migración nueva — 100% lectura de tablas existentes.

---

## 7.6 — Motor de referidos (a futuro, depende de 7.1)

**Problema:** un lead que pasa a `convertido` es el momento de mayor
satisfacción del cliente final — momento ideal para pedir referidos, y hoy
no se aprovecha.

**Solución:** cuando `client_update_lead_status` (RPC ya existente, Fase
3) recibe `p_status = 'convertido'`, disparar (via el mismo mecanismo
`pg_net` que ya usa `notify_client_pending_post`) un mensaje sugerido a
través del canal donde se originó el lead (comentario/DM), invitando a
dejar una reseña o referir un contacto. Requiere cuidado: **no debe ser
automático sin revisión** al principio — se recomienda que quede como
`proposed` para que la agencia lo apruebe antes de mandarlo, igual que el
resto del contenido generado por IA en este sistema.

**Archivos:**
- `supabase/migrations/00XX_referral_trigger.sql` (trigger sobre
  `client_update_lead_status`)
- Extender `meta-webhook/index.ts` o crear una función nueva
  `send-referral-prompt`.

---

## Orden de implementación sugerido

1. **7.1 (leads fríos)** — más simple, mayor impacto inmediato, sin IA.
2. **7.5 (reporte ROI)** — sin IA tampoco, puro reporting, útil para
   retención de clientes de la agencia ya.
3. **7.2 (alerta de bajón)** — se apoya en infraestructura de 7.1.
4. **7.3 (A/B de ángulos)** — mejora incremental sobre Fase 6 existente.
5. **7.4 (casos de éxito)** — el más sensible (anonimización), dejarlo para
   cuando el resto esté probado.
6. **7.6 (referidos)** — depende de que 7.1 y el flujo de aprobación estén
   sólidos, porque toca comunicación directa con el lead.

## Principio que se mantiene en toda la fase

Igual que el resto del sistema: **nada se manda o publica solo sin
aprobación humana cuando toca comunicación externa o contenido de marca**.
El agente propone, detecta y alerta — la agencia sigue teniendo la
decisión final, mismo criterio que ya se usa en `content_plan_items`
(`proposed` → revisar → `approved`) y en `socialbot_posts`
(`require_approval`).
