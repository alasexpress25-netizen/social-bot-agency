# Auditoría: repo público (fix de billing) + revisión de RLS en Supabase

**Fecha:** 25/07/2026
**Motivo:** El repo generó cargos inesperados en GitHub Actions ($7.42) por correr
en modo privado. Se pasó a público para resolver el billing, y se hizo una
auditoría de seguridad para confirmar que el cambio no expone datos.

---

## 1. Por qué pasamos el repo a público

- **Causa del cobro:** `post_scheduler.yml` corre cada 15 minutos, todo el día
  (96 corridas/día). Cada corrida instala Python + dependencias + ffmpeg, lo
  que consume varios minutos de máquina por corrida. Sumado a los demás
  workflows, esto superó rápido el free tier de minutos que da GitHub para
  repos **privados**.
- **Fix:** En repos **públicos**, GitHub Actions es gratis e ilimitado, sin
  importar cuántas veces corran los workflows. Por eso se pasó `social-bot-agency`
  de Private a Public (Settings → General → Danger Zone).
- **Qué NO cambia:** los GitHub Secrets (`SUPABASE_SERVICE_KEY`,
  `OPENAI_API_KEY`, `CLAUDE_API_KEY`, `GROQ_API_KEY`, etc.) siguen siendo
  privados sin importar la visibilidad del repo. Nadie puede leerlos desde
  afuera.

**Si en el futuro hace falta volver a privado** (por ejemplo, si se agrega
código o documentación que no debería ser pública), la alternativa para no
pagar de más es:
- Mover el scheduler a un cron real fuera de GitHub Actions (ej. cron job
  en Hostinger, que ya se paga aparte), o
- Bajar la frecuencia de `post_scheduler` y cachear la instalación de
  dependencias para reducir minutos consumidos.

---

## 2. Qué se revisó antes de hacerlo público

Se buscó en todo el repo (`.py`, `.ts`, `.html`, `.md`, `.txt`, `.sql`)
cualquier credencial, token o dato sensible hardcodeado. Resultado:

| Encontrado | ¿Es un problema? | Detalle |
|---|---|---|
| Tokens de ejemplo en `README.md` / `nuevo-cliente-checklist.md` | No | Son placeholders (`APP_ID`, `SHORT_LIVED_TOKEN`), instrucciones de cómo generar el token, no tokens reales. |
| `lavisualmk@alastecno.com` / `la.visualmk@gmail.com` hardcodeados en README y en las Edge Functions `notify-hot-lead` / `notify-pending-post` | No, pero mejorable | Es el mail propio de la agencia usado como destino de notificaciones, puesto a propósito. No es un dato de cliente filtrado. Si se quiere, se puede mover a variable de entorno / secret en vez de dejarlo hardcodeado. |
| Supabase **anon key** en `frontend/cliente/cliente.html` y `frontend/agencia/index.html` | No | Es normal y esperado: la anon key de Supabase está diseñada para vivir en el frontend público. La seguridad depende de RLS, no de ocultar esta key. |
| API keys reales (`sk-...`, `AKIA...`, service_role key) | No se encontró ninguna | — |

**Conclusión:** no había nada crítico que impidiera pasar el repo a público.

---

## 3. Auditoría de RLS (Row Level Security) en Supabase

Como la anon key quedó más expuesta (repo público), se revisaron las 30
migraciones en `supabase/migrations/` para confirmar que **ningún dato queda
accesible entre agencias o clientes distintos**.

### Resultado: las 18 tablas tienen RLS activado

| Tabla | RLS | Policy aplica a |
|---|---|---|
| `socialbot_agencies` | ✅ | Dueño de agencia (`owner_user_id = auth.uid()`) |
| `socialbot_clients` | ✅ | Dueño de agencia + cliente ve/edita solo su propia fila |
| `socialbot_social_accounts` | ✅ | Dueño de agencia — tabla con Page Access Tokens de Meta |
| `socialbot_ai_settings` | ✅ | Dueño de agencia + cliente (tono/temas propios) |
| `socialbot_media_assets` | ✅ | Dueño de agencia |
| `socialbot_schedule_slots` | ✅ | Dueño de agencia |
| `socialbot_posts` | ✅ | Dueño de agencia + cliente (aprobación de sus propios posts) |
| `socialbot_auto_reply_rules` | ✅ | Dueño de agencia |
| `socialbot_interactions_log` | ✅ | Dueño de agencia + cliente |
| `socialbot_leads` | ✅ | Dueño de agencia + cliente |
| `socialbot_reviews` | ✅ | Dueño de agencia |
| `socialbot_flagged_comments` | ✅ | Dueño de agencia |
| `socialbot_content_plan_items` | ✅ | Dueño de agencia + cliente |
| `socialbot_post_metrics` | ✅ | Dueño de agencia + cliente |
| `socialbot_carousel_items` | ✅ | Dueño de agencia + cliente |
| `socialbot_ai_debug_log` | ✅ | Solo `service_role` (backend), no la anon key |
| `socialbot_ai_usage_log` | ✅ | Solo `service_role` |
| `socialbot_ai_reply_cache` | ✅ | Solo `service_role` |

**Patrón general de las policies:**
- **Dueño de agencia:** solo ve/edita filas cuyo `client_id`/`agency_id`
  pertenece a una agencia con `owner_user_id = auth.uid()`.
- **Cliente final (portal):** solo ve/edita filas cuyo `client_user_id =
  auth.uid()` (su propia fila, sus propios posts, leads, etc.).
- **Tablas internas de IA:** bloqueadas para la anon key, solo accesibles
  con la `service_role` key (que nunca se expone al frontend).

No se encontró ninguna tabla sin RLS ni ninguna policy que permita leer
datos de otra agencia/cliente.

---

## 4. Checklist para el futuro

Cada vez que se agregue una tabla nueva en una migración de Supabase:

- [ ] `ALTER TABLE <tabla> ENABLE ROW LEVEL SECURITY;` en el mismo archivo
      de la migración que crea la tabla.
- [ ] Al menos una `CREATE POLICY` que filtre por `owner_user_id` (agencia)
      o `client_user_id` (cliente), según corresponda.
- [ ] Si la tabla es de uso interno/backend (logs de IA, debug, etc.),
      restringir a `service_role` en vez de dar acceso a la anon key.
- [ ] Si el repo sigue público, no hardcodear en el código ningún dato real
      de cliente (tokens, mails, teléfonos) — solo placeholders en
      documentación.

**Regla simple:** tabla nueva sin RLS explícito = queda abierta por default
con la anon key. Nunca asumir que "ya está protegida".
