# Plataforma de automatización de redes para agencias

Publica en Facebook e Instagram automáticamente 5 veces al día, con texto
generado por IA, y responde comentarios/DMs con palabras clave. Diseñada para
manejar muchos clientes sin costo de infraestructura y **sin esperar el App
Review de Meta**.

## Cómo evitamos el App Review (importante, leer primero)

Meta tiene dos niveles de acceso a su API:

* **Standard Access** (automático, sin revisión): alcanza cuando la app solo
toca páginas/cuentas de Instagram administradas por alguien que tiene un
**rol dentro de esa misma app de Meta** (Admin, Developer o Tester).
* **Advanced Access** (requiere App Review, semanas de espera): solo hace
falta si la app va a publicar en cuentas de gente que no tiene ningún rol
en tu app.

**Por eso, por cada cliente nuevo:**

1. El cliente (o vos, si te da acceso admin a su Página de Facebook) crea una
app en [developers.facebook.com](https://developers.facebook.com) —o vos
agregás al cliente como Admin/Tester en una app tuya.
2. Agregás los productos **"Facebook Login"** e **"Instagram Graph API"**.
3. Generás un **Page Access Token de larga duración** (ver pasos abajo).
4. Pegás ese token en el panel de administración (tabla `social\_accounts`
en Supabase). El sistema ya puede publicar, sin esperar nada de Meta.

Esto toma \~15 minutos por cliente la primera vez, y después es 100%
automático.

### Cómo generar el Page Access Token de larga duración (por cliente)

1. Andá a [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. Elegí la app del cliente (o la tuya con el cliente como tester).
3. En "User or Page", generá un **User Access Token** con los permisos:
`pages\_show\_list`, `pages\_read\_engagement`, `pages\_manage\_posts`,
`instagram\_basic`, `instagram\_content\_publish`, `pages\_messaging`.
4. Intercambiá ese token corto por uno de larga duración (60 días):

```
   GET https://graph.facebook.com/v21.0/oauth/access\_token?
     grant\_type=fb\_exchange\_token\&
     client\_id={APP\_ID}\&
     client\_secret={APP\_SECRET}\&
     fb\_exchange\_token={SHORT\_LIVED\_USER\_TOKEN}
   ```

5. Con ese token de usuario, pedí el listado de páginas y sus **Page Access
Token** (estos, generados a partir de un token de usuario de larga
duración, **no expiran** mientras el usuario no cambie la contraseña o
revoque el acceso):

```
   GET https://graph.facebook.com/v21.0/me/accounts?access\_token={LONG\_LIVED\_USER\_TOKEN}
   ```

6. Para Instagram, con el `page\_id` obtené el `instagram\_business\_account`:

```
   GET https://graph.facebook.com/v21.0/{page-id}?fields=instagram\_business\_account\&access\_token={PAGE\_ACCESS\_TOKEN}
   ```

7. Cargá `page\_id`, `ig\_business\_id` y `page\_access\_token` en el panel.

\---

## Arquitectura

|Pieza|Herramienta|Costo|
|-|-|-|
|Base de datos + Auth|Supabase|Gratis (plan free)|
|Publicar 5x/día|Python + GitHub Actions (cron)|Gratis|
|Generar texto|Groq / OpenAI / Claude (elegís por cliente)|Groq gratis; otros según uso|
|Auto-responder comentarios/DMs|Supabase Edge Function (webhook)|Gratis|
|Panel de administración|HTML + Supabase JS|Gratis|
|Publicar en Meta|Meta Graph API|Gratis|

## 1\. Supabase — ✅ YA HECHO

Se usó tu proyecto existente **`la.visualmk@gmail.com's Project`**
(`redaqqxoeciycqgjhpbv`). Se agregaron las tablas nuevas con prefijo
`socialbot\_` para no mezclarse con tus tablas actuales (`clientes`,
`blog\_posts`, etc.), con Row Level Security activado.

* Project URL: `https://redaqqxoeciycqgjhpbv.supabase.co`
* `frontend/index.html` ya tiene cargados el URL y el `anon key` de este
proyecto — no hace falta tocarlos.
* Te falta conseguir el **`service\_role key`** para el paso 2 (scheduler en
Python): Supabase Dashboard > Settings > API > `service\_role` (secret).
**Nunca lo pongas en el frontend**, solo en los secrets de GitHub Actions.

## 2\. Configurar el scheduler (Python + GitHub Actions) ✅ YA HECHO
1. Subí esta carpeta a un repositorio de GitHub (puede ser privado). *(Tu
conector de GitHub todavía no me aparece habilitado del lado del chat —
revisalo en el ícono de conectores; mientras tanto subilo vos manualmente
con el ZIP que te compartí.)*
2. En el repo: Settings > Secrets and variables > Actions, agregá:

   * `SUPABASE\_URL` = `https://redaqqxoeciycqgjhpbv.supabase.co`
   * `SUPABASE\_SERVICE\_KEY` = tu `service\_role key` (del paso 1, **no** la anon)
   * `GROQ\_API\_KEY` (y/o `OPENAI\_API\_KEY` / `CLAUDE\_API\_KEY`)
3. El workflow `.github/workflows/post\_scheduler.yml` ya corre 5 veces al
día. Ajustá los horarios `cron` según tu zona horaria (GitHub Actions usa
UTC siempre).
4. Podés probarlo manualmente desde la pestaña "Actions" de GitHub
(`workflow\_dispatch`) antes de esperar al primer horario programado.

## 3\. Webhook de auto-respuesta — ✅ YA DESPLEGADO

La función `meta-webhook` ya está desplegada y activa en:

```
https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/meta-webhook
```

Solo falta un paso tuyo — configurar su secret:

1. Supabase Dashboard > Edge Functions > `meta-webhook` > Secrets, agregá:

   * `META\_WEBHOOK\_VERIFY\_TOKEN` = inventá un string cualquiera (ej:
`mkbot2026verify`). `SUPABASE\_URL` y `SUPABASE\_SERVICE\_ROLE\_KEY` ya los
inyecta Supabase automáticamente, no hace falta configurarlos.
2. En el Meta App Dashboard de cada cliente (o la app compartida), andá a
**Webhooks**, suscribite a los campos `feed`, `comments` y `messages`, y
configurá:

   * Callback URL: `https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/meta-webhook`
   * Verify Token: el mismo valor que pusiste en `META\_WEBHOOK\_VERIFY\_TOKEN`

## 4\. Publicar el panel (frontend)

El archivo `frontend/index.html` es autocontenido. Podés:

* Abrirlo directo en el navegador para probar, o
* Subirlo a cualquier hosting estático gratis (Netlify, Vercel, GitHub Pages,
o el mismo Supabase Storage con un bucket público).

Desde ahí vas a poder: crear clientes, conectar sus páginas, configurar el
prompt de IA, definir horarios y reglas de auto-respuesta — todo sin tocar
código.

## 5. Activar el portal de cliente (opcional, por cliente)

1. Subí `frontend/cliente.html` al mismo hosting estático que el panel de
   agencia (puede ser una URL distinta, ej. `tu-dominio.com/cliente.html`).
2. En el panel de agencia (`frontend/index.html`), abrí la tarjeta del
   cliente y cargá su email en "Acceso del cliente". Si además querés que
   apruebe cada post antes de publicarse, tildá esa opción ahí mismo.
3. Pasale al cliente la URL de `cliente.html`. La primera vez que entra con
   su email, Supabase le manda un magic link; al hacer click queda
   vinculado automáticamente a su cuenta — no hace falta que hagas nada más
   del lado de Supabase.
4. Importante: en Supabase Dashboard → Authentication → URL Configuration,
   agregá la URL donde vive `cliente.html` a la lista de **Redirect URLs**
   permitidas, o el magic link no va a poder volver a la página.

## 6\. Cargar imágenes/videos para los posts

Subí las imágenes a un bucket público de **Supabase Storage** y agregá cada
URL a la tabla `media\_assets` (por ahora se hace desde el SQL editor o
Table editor de Supabase; se puede agregar al panel HTML más adelante si
querés).

\---

## 🚧 Roadmap en implementación (julio 2026 en adelante)

Plan acordado para llevar el bot de "publica y responde con palabra clave" a
plataforma de agencia completa. Cada fase se implementa y se prueba antes de
pasar a la siguiente. Este README se va actualizando a medida que cada fase
queda lista.

### Principio de uso prudente de IA (Groq free tier)

Mientras la agencia tenga pocos clientes, todo corre sobre el free tier de
Groq. Para no quedarnos sin cuota:

* Se registra el uso de IA por cliente en `socialbot\_ai\_usage\_log` (conteo
diario).
* Si un cliente supera el umbral diario configurado, el sistema cae
automáticamente a respuesta con plantilla fija (sin romper el flujo).
* Se cachean respuestas repetidas para no llamar dos veces a la IA por la
misma pregunta.
* La tabla `socialbot\_ai\_settings` ya tiene columna `provider` — el día que
haya presupuesto, se pasa un cliente puntual a OpenAI/Claude sin tocar el
resto del código.

### Fases

* [x] **Fase 1 — IA conversacional prudente en el webhook.**
Reemplaza el matching de palabra clave por una llamada a Groq con el
contexto del cliente (`topics`, `tone`, `sales\_link`). Suma control de
límite diario de uso por cliente con fallback a plantilla fija.
*Archivos: `supabase/migrations/0003\_ai\_usage\_log.sql`,
`supabase/functions/meta-webhook/index.ts`.*

  > **Actualización 15/07/2026 — corrección + base de conocimiento.** Se
  > detectó que la versión desplegada en producción de `meta-webhook` había
  > quedado desactualizada: en algún momento se le agregó el "private
  > reply" (mensaje privado con el link, para que salga clickeable) pero se
  > perdió toda la lógica de IA de esta fase — el sistema llevaba tiempo
  > respondiendo *solo* por palabra clave, sin llamar nunca a Groq
  > (`socialbot_ai_usage_log` estaba vacía). Se restauró la lógica de IA +
  > detección de leads, manteniendo el private reply.
  >
  > De paso se agregó `socialbot_ai_settings.knowledge_base`: un texto
  > libre por cliente (servicios, precios reales, FAQ, políticas — un
  > "mini-README del negocio") que se inyecta en el prompt como fuente de
  > verdad, para que la IA responda con precisión en vez de improvisar
  > sobre `topics`/`tone` solamente. Se usa tanto al responder
  > comentarios/DMs (`meta-webhook`) como al generar el texto de los posts
  > (`post_scheduler.py`), y se edita desde el mismo `<details>` de
  > "Configurar IA" en `frontend/index.html`.
  > *Archivos: `supabase/migrations/0011_ai_knowledge_base.sql`,
  > `supabase/functions/meta-webhook/index.ts`, `scheduler/post_scheduler.py`,
  > `frontend/index.html`. También `supabase/migrations/0010_ai_debug_log.sql`
  > (tabla temporal de diagnóstico usada para encontrar el problema).*
  > **Actualización 15/07/2026 (más tarde) — bucle de respuestas
  > duplicadas.** Se detectó que el bot podía terminar respondiéndose a sí
  > mismo: su propia respuesta a un comentario es, para Meta, un comentario
  > nuevo, que puede volver a disparar el webhook de `comments` — el bot lo
  > tomaba como un comentario más de un usuario real y volvía a responder,
  > en cadena (se vio un caso real: 15 respuestas encadenadas en ~1 minuto
  > a partir de un solo comentario). Se corrigió con dos protecciones en
  > `meta-webhook`, sin cambios de esquema (se reusa la constraint
  > `unique (platform, external_id)` ya existente desde 0001_init.sql):
  > 1. Se ignora cualquier comentario/DM cuyo `senderId` sea la propia
  >    cuenta (`page_id` / `ig_business_id`) — el bot nunca reacciona a
  >    algo que publicó él mismo.
  > 2. El comentario se "reserva" en `socialbot_interactions_log` **antes**
  >    de generar la respuesta (insert que aprovecha la unique constraint
  >    para fallar si ya estaba reservado), en vez de recién al final —
  >    cierra una ventana de carrera donde dos entregas casi simultáneas
  >    del mismo evento (algo común en webhooks) podían pasar ambas la
  >    validación de "ya fue manejado" y las dos terminar respondiendo.
  > *Archivo: `supabase/functions/meta-webhook/index.ts` (mismo archivo de
  > la actualización anterior, sin migración nueva).*
* [x] **Fase 2 — Calificación y guardado de leads.**
La misma llamada de IA de la Fase 1 devuelve, además de la respuesta,
si el contacto es un lead caliente y sus datos (nombre, contacto,
interés), y se guardan en `socialbot\_leads` vía upsert por
`(client_id, platform, sender_id)`. No suma costo extra de tokens
(reusa la llamada de la Fase 1). El lead solo se guarda cuando la
respuesta sale fresca de la IA (`source: "ia"`); si sale del cache de
respuestas repetidas no se vuelve a evaluar como lead, para no crear
duplicados idénticos por una pregunta genérica repetida.
*Archivos: `supabase/migrations/0004\_leads.sql`,
`supabase/functions/meta-webhook/index.ts`.*
* [x] **Fase 3 — Panel de cliente separado (login + RLS).**
  Nuevo `frontend/cliente.html` con Supabase Auth vía **magic link** (el
  cliente entra con su email, sin contraseña que administrar). La agencia
  carga el email del cliente desde su propio panel (`client_email` en
  `socialbot_clients`); la primera vez que el cliente entra, su cuenta se
  vincula sola a esa fila (self-claim).
  De paso se adelantó parte de la Fase 5: cada cliente puede tener
  `require_approval = true`, en cuyo caso el scheduler genera el post pero
  no lo publica hasta que el cliente lo aprueba o rechaza desde su portal
  (`socialbot_posts.approval_status`). El cliente también puede actualizar
  el estado de sus propios leads y su tono/temas de IA.
  **Seguridad:** el cliente no tiene ningún `UPDATE` directo por tabla.
  Todo lo que puede modificar (aprobar/rechazar post, cambiar estado de
  lead, actualizar tono/temas) pasa por 4 funciones RPC en Postgres
  (`client_claim_account`, `client_review_post`,
  `client_update_lead_status`, `client_update_ai_prefs`), que corren con
  `SECURITY DEFINER` y validan del lado del servidor quién es el dueño de
  la fila, qué campo se toca y qué valores están permitidos — no dependen
  de que el HTML se comporte bien.
  *Archivos: `frontend/cliente.html`, `frontend/index.html` (asignar email
  del cliente y toggle de aprobación), `scheduler/post_scheduler.py`
  (respeta `require_approval` y publica lo aprobado en la siguiente
  corrida), `supabase/migrations/0006_client_portal.sql`.*
* [x] **Fase 4 — Dashboard de métricas.**
  Gráficos de leads por semana, posts publicados por semana y tasa de
  respuesta automática a comentarios/DMs, en ambos paneles (agencia y
  cliente), agrupando por semana ISO (lunes a domingo) los datos que ya se
  guardaban desde las Fases 1 y 2 (`socialbot_leads`, `socialbot_posts`,
  `socialbot_interactions_log`). Barras simples en HTML/CSS puro, sin sumar
  librerías nuevas.
  El portal de cliente no podía leer `socialbot_interactions_log` hasta
  ahora (solo la veía la agencia), así que se sumó una policy de
  solo-lectura nueva para que el cliente pueda calcular su propia tasa de
  respuesta.
  *Archivos: `frontend/index.html` (métricas por cliente, dentro de un
  `<details>`), `frontend/cliente.html` (sección "Métricas"),
  `supabase/migrations/0008_client_metrics_access.sql`.*
* [x] **Fase 5 — Aprobación de contenido antes de publicar.**
  El flujo borrador → aprobado → publicado ya venía en gran parte de la
  Fase 3 (`require_approval`, `approval_status`, RPC `client_review_post`
  en el portal de cliente). Esta fase cerró lo que faltaba:
  * La **agencia** ahora también puede aprobar/rechazar (y editar el texto
    de) un post pendiente desde su propio panel — útil si el cliente
    todavía no tiene el portal activado, o hay apuro. No necesitó ninguna
    función RPC nueva: la agencia ya tenía `UPDATE` directo sobre
    `socialbot_posts` vía la policy `"owner sees own posts"` (0001_init.sql,
    `for all`); solo faltaba la UI.
  * **Notificación por email al cliente**: cada vez que el scheduler genera
    un post que queda pendiente de aprobación, un trigger de Postgres
    (`pg_net`) llama a una Edge Function nueva (`notify-pending-post`) que
    le manda un mail avisándole, con un preview del texto propuesto. Manda
    el correo por **SMTP directo contra Hostinger** (el mismo correo que ya
    usa la agencia, `lavisualmk@alastecno.com` — `smtp.hostinger.com:465`
    con TLS), sin depender de ningún servicio de terceros. Si no se
    configuran las credenciales SMTP, el sistema simplemente no manda el
    email (no rompe nada, mismo criterio de "fallback silencioso" que el
    resto del proyecto). Opcionalmente se puede setear `CLIENT_PORTAL_URL`
    (la URL donde vive `cliente.html`) para incluirla en el cuerpo del mail.
  *Archivos: `frontend/index.html` (sección de aprobación por post en la
  tarjeta de cada cliente), `supabase/migrations/0009_agency_approval_and_pending_notification.sql`,
  `supabase/functions/notify-pending-post/index.ts`.*

  **✅ Ya configurado y probado** (dashboard de Supabase → Edge Functions →
  `notify-pending-post` → Secrets): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASS` apuntando al correo de Hostinger (`lavisualmk@alastecno.com`).
  Probado end-to-end el 14/07/2026: post pendiente insertado manualmente →
  trigger disparó `notify-pending-post` → email recibido en
  `la.visualmk@gmail.com`. Opcional, todavía sin cargar: `CLIENT_PORTAL_URL`
  (URL pública de `cliente.html`, para incluirla en el cuerpo del mail) y
  `SMTP_FROM` (si se quiere un remitente distinto a `SMTP_USER`).

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

  **Cuota de IA separada:** el plan semanal usa su propio provider
  (`socialbot_ai_settings.content_plan_provider`, independiente del
  `provider` que usan el webhook de comentarios/DMs y el caption al
  momento de publicar) y, si ese provider es Groq, su propia API key
  (`GROQ_API_KEY_CONTENT_PLAN`, secret separado en GitHub Actions) — así
  un cliente con mucho movimiento de comentarios no le come la cuota
  gratuita al cron semanal, ni al revés.

  **Seguridad / alcance de esta primera versión:** por ahora solo la
  agencia puede aprobar/editar el plan (mismo patrón de RLS `for all` que
  ya tenía sobre `socialbot_posts`, sin necesitar RPC nueva). El cliente
  puede *ver* su propio plan (policy de solo lectura) pero no actuar sobre
  él todavía — si más adelante se quiere que también opine/apruebe desde
  su portal, se agrega siguiendo el mismo patrón de funciones RPC
  `SECURITY DEFINER` que ya usa el resto de acciones de cliente (ver
  `0006_client_portal.sql`).

  *Archivos: `supabase/migrations/0012_post_metrics.sql`,
  `supabase/migrations/0013_content_plan.sql`,
  `supabase/migrations/0014_content_plan_provider.sql`,
  `scheduler/post_scheduler.py` (recolección de métricas + uso del plan
  aprobado), `scheduler/content_planner.py` (nuevo),
  `.github/workflows/content_planner.yml` (nuevo, cron semanal),
  `frontend/index.html` (sección "Plan semanal de contenido" por cliente
  + selector de `content_plan_provider`).*

  **✅ Terminada y en producción (15/07/2026).** Las 3 migraciones están
  aplicadas en `redaqqxoeciycqgjhpbv` (tablas `socialbot_post_metrics` y
  `socialbot_content_plan_items` con sus policies, y la columna
  `content_plan_provider`), `content_planner.py` y `post_scheduler.py`
  están subidos, el workflow `.github/workflows/content_planner.yml` está
  cargado, `frontend/index.html` tiene la sección del plan semanal
  integrada, y el secret `GROQ_API_KEY_CONTENT_PLAN` ya está cargado en
  GitHub (Settings → Secrets and variables → Actions). No queda nada
  pendiente de esta fase.

### Backlog (más adelante, cuando haya 5+ clientes)

* [ ] Botón "conectar cuenta" con OAuth automático en vez de pegar el token
a mano (requiere Advanced Access si vas a manejar cuentas que no
administrás directamente vos).
* [ ] Refresco automático del Page Access Token antes de que venza.
* [ ] Generación de imágenes con IA (ej. vía Groq/otros) además del texto.
* [ ] Subida de medios directo desde el panel (hoy se hace vía Supabase
Storage a mano).
* [ ] Respuesta a menciones y Stories (hoy el webhook solo cubre feed,
comments y messages).
