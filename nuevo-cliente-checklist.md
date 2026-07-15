# Alta de cliente nuevo — Camino B (vos hacés todo)

Guía rápida para conectar Facebook + Instagram de un cliente al panel
(`index.html`), sin que el cliente tenga que tocar developers.facebook.com
ni entender de tokens. Tiempo real: ~15-20 min si todo sale bien a la
primera.

**Regla de oro:** la app de Meta (la del bot) **ya existe y es una sola**.
No se crea una app nueva por cliente. Lo único que cambia por cliente es
la Página/Instagram que conectás a esa misma app.

---

## Paso 0 — Requisito: el cliente necesita Instagram Business + Página de Facebook

Si el cliente **ya tiene** Instagram profesional vinculado a una Página de
Facebook, saltá directo al Paso 1.

Si tiene Instagram **personal** y/o no tiene Facebook, hay que hacer esto
primero **con su celular/compu, logueado con SU cuenta** (esto no lo podés
hacer vos por él):

1. Instagram → Configuración → Cuenta → **"Cambiar a cuenta profesional"**
   → elegir **Business** (no Creator).
2. En el mismo asistente, **vincular/crear una Página de Facebook**. Si no
   tiene ninguna, Instagram le deja crear una ahí mismo (no importa que
   quede "vacía", es solo el contenedor técnico que pide Meta).
3. Antes de despedirte, verificá que quedó bien vinculado: Página de
   Facebook → Configuración → Instagram → debería figurar la cuenta
   conectada.

> Si el cliente ya tiene Página de Facebook pero el Instagram sigue sin
> aparecer vinculado ahí, es este mismo paso el que falta — repetirlo.

---

## Paso 1 — El cliente te agrega como Admin de su Página

El cliente entra a **Meta Business Suite** (o Configuración de la Página
en Facebook) → Página → Acceso a la Página → Agregar personas → te busca
por tu perfil de Facebook → te asigna rol de **Admin**.

Vos **no entrás nunca con la cuenta del cliente**. Seguís siempre logueado
con tu propia cuenta de Facebook — el rol de Admin te da acceso a *su*
Página desde *tu* login.

El cliente recibe una notificación para confirmar el acceso — avisale que
la acepte si no lo hizo todavía.

---

## Paso 2 — Generar el token (todo esto lo hacés vos, con tu cuenta)

Andá a [Graph API Explorer](https://developers.facebook.com/tools/explorer/),
elegí **tu app** (la del bot, ya existente).

### 2.1 — User Access Token con estos 6 permisos:
```
pages_show_list
pages_read_engagement
pages_manage_posts
instagram_basic
instagram_content_publish
pages_messaging
```

### 2.2 — Extenderlo a token de larga duración (60 días)

PowerShell:
```powershell
Invoke-RestMethod "https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN"
```
curl (Git Bash / WSL / Mac):
```bash
curl "https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_LIVED_TOKEN"
```
Te devuelve un `access_token` nuevo — ese es el **User Access Token de
larga duración**. Guardalo, lo usás en el paso siguiente.

### 2.3 — Sacar el Page Access Token (no expira)

PowerShell:
```powershell
$r = Invoke-RestMethod "https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN"
$r.data | Format-Table name, id
```
curl:
```bash
curl "https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN"
```

Esto te devuelve **todas** las Páginas donde tenés algún rol (las tuyas +
las de todos tus clientes). Identificá la del cliente **por `name`**, y
si hay dudas, comparalo con el `id` que ves en la URL de su Página de
Facebook. De esa fila sacás:
- `id` → es el **`page_id`**
- `access_token` → es el **`page_access_token`** (no expira salvo que el
  cliente cambie su contraseña o te saque el acceso admin)

> Tip: anotá el `page_id` de cada cliente apenas lo conectás la primera
> vez. Con muchos clientes, la lista de `/me/accounts` se vuelve larga y
> es más fácil buscar por ID que confiar solo en el nombre.

### 2.4 — Sacar el `ig_business_id`

PowerShell:
```powershell
Invoke-RestMethod "https://graph.facebook.com/v21.0/PAGE_ID?fields=instagram_business_account&access_token=PAGE_ACCESS_TOKEN"
```
curl:
```bash
curl "https://graph.facebook.com/v21.0/PAGE_ID?fields=instagram_business_account&access_token=PAGE_ACCESS_TOKEN"
```
El `id` dentro de `instagram_business_account` es el **`ig_business_id`**.

---

## Paso 3 — Cargar todo en el panel

En `index.html`, tarjeta del cliente → formulario "Conectar cuenta"
(`addAccount`) → completás:

| Campo | Valor |
|---|---|
| `platform` | `facebook` o `instagram` (una fila por cada una) |
| `page_id` | del paso 2.3 |
| `ig_business_id` | del paso 2.4 (solo fila de Instagram) |
| `page_name` | nombre de la Página, para identificarla en el panel |
| `page_access_token` | del paso 2.3 |

Guardás y listo — el bot ya puede publicar y responder como si fuera el
cliente.

---

## Paso 4 (opcional pero recomendado) — Webhook de auto-respuesta

En el Meta App Dashboard de tu app → **Webhooks** → suscribirse a
`feed`, `comments` y `messages`:
- Callback URL: `https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/meta-webhook`
- Verify Token: el mismo valor que tenés cargado en
  `META_WEBHOOK_VERIFY_TOKEN` (Supabase → Edge Functions → `meta-webhook`
  → Secrets)

---

## Problemas

**`instagram_business_account` no aparece en la respuesta del paso 2.4
(viene vacío o falta el campo)**
→ La cuenta de Instagram no quedó vinculada a la Página. Hay que volver
al Paso 0 con el cliente: Instagram → Configuración → Cuenta vinculada a
Facebook (o desde la Página → Configuración → Instagram) y confirmar la
conexión. No hay forma de arreglar esto con tu Page Access Token — requiere
el login del cliente.

**No encontrás la Página del cliente en `/me/accounts`**
→ Confirmá que el cliente ya aceptó la invitación de Admin (Paso 1) —
mientras no acepta, no aparece en la lista aunque vos ya la hayas mandado.
También puede ser que la haya aceptado con otro rol (Editor, por ejemplo)
en vez de Admin; pedile que revise el rol asignado.

**El token corto/largo tira error `Invalid OAuth access token` o
similar**
→ Los User Access Token del Graph API Explorer expiran rápido (a veces en
minutos). Generá uno nuevo justo antes de hacer el intercambio del paso
2.2, no lo dejes guardado de una sesión anterior.

**El intercambio a token de larga duración (paso 2.2) falla con `Error
validating application`**
→ Revisá que `APP_ID` y `APP_SECRET` sean los de tu app (no los de otra
app vieja). El `APP_SECRET` está en developers.facebook.com → tu app →
Configuración → Básica.

**El Page Access Token "dejó de funcionar" después de un tiempo**
→ A pesar de que en teoría no expira, se corta si: el cliente cambió su
contraseña de Facebook, te quitó el rol de Admin de la Página, o la app
perdió el permiso (revisar en Configuración de la Página → Integraciones
que la app siga listada). Solución: repetir el Paso 2 completo para
regenerar el token.

**Publica en Facebook pero no en Instagram (o al revés)**
→ Revisá que cargaste **dos filas** en `socialbot_social_accounts` (una
`platform: facebook` y otra `platform: instagram`), no una sola fila
mezclando campos de ambas.

**El cliente te agregó como Admin pero en `Invoke-RestMethod`/`curl`
te sigue sin aparecer nada nuevo**
→ Puede haber demora de propagación de unos minutos del lado de Meta.
Esperá 5-10 min y repetí la llamada del paso 2.3 antes de asumir que algo
está mal.

**PowerShell corta la URL o tira error raro por el `&` del token**
→ Envolvé toda la URL entre comillas dobles, como en los ejemplos de
arriba (`Invoke-RestMethod "https://..."`). Sin comillas, PowerShell
puede interpretar mal el `&`.
