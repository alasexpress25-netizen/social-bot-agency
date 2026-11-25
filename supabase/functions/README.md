# Edge Functions del bot

**Esta carpeta no contiene código ejecutable.**

Las funciones del bot (por ejemplo `meta-webhook`) viven y se ejecutan en
**Supabase**, en el proyecto `redaqqxoeciycqgjhpbv`. GitHub no despliega nada
de esta carpeta, así que cualquier copia del código que estuviera aquí podía
quedar desactualizada y confundir.

## Dónde está la versión real

- Supabase → proyecto `redaqqxoeciycqgjhpbv` → **Edge Functions**.
- La versión desplegada es la única válida. Para verla o editarla, usar el
  panel de Supabase.
- El historial resumido de cambios también está en el comentario inicial del
  propio `index.ts` de `meta-webhook`.

## Cambios importantes ya aplicados en Supabase

### meta-webhook (versión actual: 59, 25/11/2026)

- **Versión 50 (24/11/2026):**
  - Los mensajes directos toman la plataforma de `body.object`, así que los
    DMs de Instagram se buscan como `instagram` y encuentran la cuenta.
  - Se ignoran los eventos `is_echo` (mensajes enviados por la propia cuenta),
    para que el bot no se responda a sí mismo.
- **Versiones 51 a 54 (24/11/2026):**
  - Groq dio de baja `llama-3.1-8b-instant`; se agregaron logs de diagnóstico
    en `socialbot_ai_debug_log`.
  - **Gemini** pasa a ser el proveedor de IA principal (secret `GEMINI_MODEL`)
    y **Groq** el respaldo (secret `GROQ_MODEL`). Si ambos fallan, se usan las
    reglas por palabra clave.
  - Gemini se reintenta una vez ante 429/500/503 antes de pasar a Groq, con
    timeout de 15 s por proveedor.
  - El webhook responde **200 a Meta de inmediato** y procesa en segundo plano
    (`EdgeRuntime.waitUntil`). Antes Meta reenviaba el mismo DM cada ~20 s.
  - El id del DM sale del `mid` de Meta, así un reenvío no se procesa dos veces.
- **Versión 55 (24/11/2026):** diagnóstico de eventos `is_echo`. Se registran
  `sender_id`, `recipient_id` y si trae `mid`. Un evento marcado como eco cuyo
  remitente **no** es la propia cuenta y cuyo destinatario **sí** lo es se
  trata como DM entrante. Los ecos reales (respuestas del propio bot) siguen
  ignorados.
- **Versiones 56 y 57:** ajustes menores previos al anti-spam nuevo (no
  detallados en el historial del código).
- **Versión 58 (25/11/2026):** anti-spam más claro.
  - **Agrupación de DMs seguidos:** cada DM espera 8 s (`DM_GROUP_WINDOW_MS`).
    Si el mismo usuario escribió otro después, el primero se marca `agrupado`
    y solo el último responde, con el texto de todos juntos. Los `agrupado` no
    cuentan para el límite por hora.
  - **Aviso al pasar el límite:** con el límite por hora superado, el bot manda
    un solo aviso por DM (texto en
    `socialbot_ai_settings.anti_spam_reply_template`, con default) y del
    siguiente en adelante queda en silencio (`anti-spam-limite`). En
    comentarios no se avisa, porque sería público.
- **Versión 59 (25/11/2026):** planes de Impacto TV en vivo. Si la base de
  conocimiento del cliente contiene el marcador `[[PLANOS_IMPACTO_TV]]`, se
  reemplaza por los planes activos de la tabla `planes` del proyecto
  **Impacto3d** (lectura pública con clave publishable, caché de 60 s). La
  clave de caché de respuestas incluye un hash de esos planes: si cambia un
  precio, las respuestas guardadas dejan de usarse. Si la consulta falla, se le
  indica a la IA que no informe valores y no se usa ni se guarda caché.

## Secrets de `meta-webhook`

- `META_WEBHOOK_VERIFY_TOKEN`: verificación del webhook con Meta.
- `GEMINI_API_KEY`, `GEMINI_MODEL`: IA principal (hoy `gemini-3.5-flash-lite`;
  los alias y modelos viejos se dan de baja, y devuelven 404 o 503).
- `GROQ_API_KEY`, `GROQ_MODEL`: respaldo (hoy `openai/gpt-oss-20b`).
- `IMPACTO_SUPABASE_URL`, `IMPACTO_PUBLISHABLE_KEY`: **opcionales**. El código
  ya trae por defecto el proyecto Impacto3d y su clave publishable. Solo sirven
  para sobrescribirlos. Nunca usar la clave secret de Impacto3d.
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase.

## Configuración de Meta que depende de estas funciones

- App de Meta: **LaVisualMK SocialBot** (ID `1513676860510360`), dentro del
  portfolio empresarial de La Visual MK.
- URL de callback del webhook: apunta a la función `meta-webhook`.
- Cada página debe estar suscripta a la app con los campos `messages`,
  `messaging_postbacks` y `feed`.
- Los tokens de página están en la tabla `socialbot_social_accounts`
  (columna `page_access_token`), uno por página y plataforma.
- Sin Advanced Access los DMs llegan igual de cuentas con o sin rol en la app
  (verificado con una cuenta sin rol).
- Para probar DMs, escribir **desde otra cuenta**, nunca desde la propia cuenta
  del bot: sus mensajes salen como `is_echo` y se ignoran.

## Si en el futuro se quiere versionar el código

Exportar las funciones desde Supabase a esta carpeta y volver a editar este
archivo, indicando que esa copia es solo un respaldo y que Supabase sigue
siendo la fuente de verdad.
