# Plataforma de automatización de redes para agencias

Publica en Facebook e Instagram automáticamente 5 veces al día, con texto
generado por IA, y responde comentarios/DMs con palabras clave. Diseñada para
manejar muchos clientes sin costo de infraestructura y **sin esperar el App
Review de Meta**.

## Cómo evitamos el App Review (importante, leer primero)

Meta tiene dos niveles de acceso a su API:

- **Standard Access** (automático, sin revisión): alcanza cuando la app solo
  toca páginas/cuentas de Instagram administradas por alguien que tiene un
  **rol dentro de esa misma app de Meta** (Admin, Developer o Tester).
- **Advanced Access** (requiere App Review, semanas de espera): solo hace
  falta si la app va a publicar en cuentas de gente que no tiene ningún rol
  en tu app.

**Por eso, por cada cliente nuevo:**

1. El cliente (o vos, si te da acceso admin a su Página de Facebook) crea una
   app en [developers.facebook.com](https://developers.facebook.com) —o vos
   agregás al cliente como Admin/Tester en una app tuya.
2. Agregás los productos **"Facebook Login"** e **"Instagram Graph API"**.
3. Generás un **Page Access Token de larga duración** (ver pasos abajo).
4. Pegás ese token en el panel de administración (tabla `social_accounts`
   en Supabase). El sistema ya puede publicar, sin esperar nada de Meta.

Esto toma ~15 minutos por cliente la primera vez, y después es 100%
automático.

### Cómo generar el Page Access Token de larga duración (por cliente)

1. Andá a [Graph API Explorer](https://developers.facebook.com/tools/explorer/).
2. Elegí la app del cliente (o la tuya con el cliente como tester).
3. En "User or Page", generá un **User Access Token** con los permisos:
   `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
   `instagram_basic`, `instagram_content_publish`, `pages_messaging`.
4. Intercambiá ese token corto por uno de larga duración (60 días):
   ```
   GET https://graph.facebook.com/v21.0/oauth/access_token?
     grant_type=fb_exchange_token&
     client_id={APP_ID}&
     client_secret={APP_SECRET}&
     fb_exchange_token={SHORT_LIVED_USER_TOKEN}
   ```
5. Con ese token de usuario, pedí el listado de páginas y sus **Page Access
   Token** (estos, generados a partir de un token de usuario de larga
   duración, **no expiran** mientras el usuario no cambie la contraseña o
   revoque el acceso):
   ```
   GET https://graph.facebook.com/v21.0/me/accounts?access_token={LONG_LIVED_USER_TOKEN}
   ```
6. Para Instagram, con el `page_id` obtené el `instagram_business_account`:
   ```
   GET https://graph.facebook.com/v21.0/{page-id}?fields=instagram_business_account&access_token={PAGE_ACCESS_TOKEN}
   ```
7. Cargá `page_id`, `ig_business_id` y `page_access_token` en el panel.

---

## Arquitectura

| Pieza | Herramienta | Costo |
|---|---|---|
| Base de datos + Auth | Supabase | Gratis (plan free) |
| Publicar 5x/día | Python + GitHub Actions (cron) | Gratis |
| Generar texto | Groq / OpenAI / Claude (elegís por cliente) | Groq gratis; otros según uso |
| Auto-responder comentarios/DMs | Supabase Edge Function (webhook) | Gratis |
| Panel de administración | HTML + Supabase JS | Gratis |
| Publicar en Meta | Meta Graph API | Gratis |

## 1. Supabase — ✅ YA HECHO

Se usó tu proyecto existente **`la.visualmk@gmail.com's Project`**
(`redaqqxoeciycqgjhpbv`). Se agregaron las tablas nuevas con prefijo
`socialbot_` para no mezclarse con tus tablas actuales (`clientes`,
`blog_posts`, etc.), con Row Level Security activado.

- Project URL: `https://redaqqxoeciycqgjhpbv.supabase.co`
- `frontend/index.html` ya tiene cargados el URL y el `anon key` de este
  proyecto — no hace falta tocarlos.
- Te falta conseguir el **`service_role key`** para el paso 2 (scheduler en
  Python): Supabase Dashboard > Settings > API > `service_role` (secret).
  **Nunca lo pongas en el frontend**, solo en los secrets de GitHub Actions.

## 2. Configurar el scheduler (Python + GitHub Actions)

1. Subí esta carpeta a un repositorio de GitHub (puede ser privado). *(Tu
   conector de GitHub todavía no me aparece habilitado del lado del chat —
   revisalo en el ícono de conectores; mientras tanto subilo vos manualmente
   con el ZIP que te compartí.)*
2. En el repo: Settings > Secrets and variables > Actions, agregá:
   - `SUPABASE_URL` = `https://redaqqxoeciycqgjhpbv.supabase.co`
   - `SUPABASE_SERVICE_KEY` = tu `service_role key` (del paso 1, **no** la anon)
   - `GROQ_API_KEY` (y/o `OPENAI_API_KEY` / `CLAUDE_API_KEY`)
3. El workflow `.github/workflows/post_scheduler.yml` ya corre 5 veces al
   día. Ajustá los horarios `cron` según tu zona horaria (GitHub Actions usa
   UTC siempre).
4. Podés probarlo manualmente desde la pestaña "Actions" de GitHub
   (`workflow_dispatch`) antes de esperar al primer horario programado.

## 3. Webhook de auto-respuesta — ✅ YA DESPLEGADO

La función `meta-webhook` ya está desplegada y activa en:
```
https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/meta-webhook
```

Solo falta un paso tuyo — configurar su secret:

1. Supabase Dashboard > Edge Functions > `meta-webhook` > Secrets, agregá:
   - `META_WEBHOOK_VERIFY_TOKEN` = inventá un string cualquiera (ej:
     `mkbot2026verify`). `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` ya los
     inyecta Supabase automáticamente, no hace falta configurarlos.
2. En el Meta App Dashboard de cada cliente (o la app compartida), andá a
   **Webhooks**, suscribite a los campos `feed`, `comments` y `messages`, y
   configurá:
   - Callback URL: `https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/meta-webhook`
   - Verify Token: el mismo valor que pusiste en `META_WEBHOOK_VERIFY_TOKEN`

## 4. Publicar el panel (frontend)

El archivo `frontend/index.html` es autocontenido. Podés:
- Abrirlo directo en el navegador para probar, o
- Subirlo a cualquier hosting estático gratis (Netlify, Vercel, GitHub Pages,
  o el mismo Supabase Storage con un bucket público).

Desde ahí vas a poder: crear clientes, conectar sus páginas, configurar el
prompt de IA, definir horarios y reglas de auto-respuesta — todo sin tocar
código.

## 5. Cargar imágenes/videos para los posts

Subí las imágenes a un bucket público de **Supabase Storage** y agregá cada
URL a la tabla `media_assets` (por ahora se hace desde el SQL editor o
Table editor de Supabase; se puede agregar al panel HTML más adelante si
querés).

---

## Roadmap sugerido (para cuando quieras escalar)

- [ ] Botón "conectar cuenta" con OAuth automático en vez de pegar el token
      a mano (requiere Advanced Access si vas a manejar cuentas que no
      administrás directamente vos).
- [ ] Refresco automático del Page Access Token antes de que venza.
- [ ] Generación de imágenes con IA (ej. vía Groq/otros) además del texto.
- [ ] Subida de medios directo desde el panel (hoy se hace vía Supabase
      Storage a mano).
- [ ] Dashboard de métricas (impresiones, alcance) usando Insights API.
