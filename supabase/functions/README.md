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

## Cambios importantes ya aplicados en Supabase

- **meta-webhook (versión 55, 24/11/2026):**
  - La IA principal pasa a ser **Gemini** (alias `gemini-flash-latest`,
    configurable con el secret `GEMINI_MODEL`). **Groq** queda como respaldo
    (`openai/gpt-oss-20b`, configurable con `GROQ_MODEL`). Si ambos fallan, se
    usan las reglas de auto-respuesta por palabra clave y, al final, la
    respuesta genérica.
  - Groq dio de baja `llama-3.1-8b-instant` el 16/08/2026, por eso la IA del
    webhook no respondía (error 404 `model_not_found`).
  - Se agregaron registros de diagnóstico en `socialbot_ai_debug_log`
    (eventos de mensajería recibidos, cuenta no encontrada, errores de
    Gemini/Groq y rechazos de Meta al enviar un DM).
- **meta-webhook (versión 50, 24/11/2026):**
  - Los mensajes directos toman la plataforma de `body.object`, así que los
    DMs de Instagram se buscan como `instagram` y encuentran la cuenta.
  - Se ignoran los eventos `is_echo` (mensajes enviados por la propia cuenta),
    para que el bot no se responda a sí mismo.

## Configuración de Meta que depende de estas funciones

- App de Meta: **LaVisualMK SocialBot** (ID `1513676860510360`), dentro del
  portfolio empresarial de La Visual MK.
- URL de callback del webhook: apunta a la función `meta-webhook`.
- Cada página debe estar suscripta a la app con los campos `messages`,
  `messaging_postbacks` y `feed`.
- Secrets de la función (Supabase → Edge Functions → Secrets):
  `GEMINI_API_KEY` (IA principal), `GROQ_API_KEY` (respaldo),
  `META_WEBHOOK_VERIFY_TOKEN`, y opcionalmente `GEMINI_MODEL`, `GROQ_MODEL`
  y `LINK_DOMAIN`. Los secrets de GitHub no los usa esta función.
- Los tokens de página están en la tabla `socialbot_social_accounts`
  (columna `page_access_token`), uno por página y plataforma.

## Si en el futuro se quiere versionar el código

Exportar las funciones desde Supabase a esta carpeta y volver a editar este
archivo, indicando que esa copia es solo un respaldo y que Supabase sigue
siendo la fuente de verdad.
