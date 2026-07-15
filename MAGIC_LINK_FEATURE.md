# Magic Link Automático para Clientes

## Resumen

Ahora cuando la agencia presiona "Guardar acceso" en el panel de agencia (index.html) con un email del cliente, **se envía automáticamente un magic link al cliente** sin que tenga que hacer nada más.

## Flujo

### Antes (manual)
1. Agencia carga email del cliente + presiona "Guardar acceso"
2. Agencia le dice al cliente: "Entra en cliente.html, pone tu email y pide el link"
3. Cliente entra, pone email, presiona botón
4. Cliente recibe magic link por email
5. Cliente hace clic, entra al panel

### Ahora (automático)
1. Agencia carga email del cliente + presiona "Guardar acceso"
2. **Magic link se envía automáticamente al cliente por email**
3. Cliente recibe email con link listo para usar
4. Cliente hace clic, entra al panel (sin pasos intermedios)

## Detalles técnicos

### Edge Function: `send-client-magic-link`

**Ubicación en Supabase:** `redaqqxoeciycqgjhpbv` → Edge Functions → `send-client-magic-link`

**Qué hace:**
1. Recibe el email del cliente desde el frontend (index.html)
2. Genera un magic link usando la Auth API de Supabase (`admin.generateLink`)
3. Envía un email formateado (HTML) con el link via SMTP (Hostinger)

**Endpoint:** 
```
POST https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/send-client-magic-link
```

**Payload esperado:**
```json
{
  "client_email": "cliente@email.com",
  "agency_name": "LaVisualMk"
}
```

**Respuesta exitosa:**
```json
{ "ok": true, "message": "Magic link enviado" }
```

### Frontend: `index.html` (`saveClientPortalAccess`)

**Cambios:**
- Cuando se presiona "Guardar acceso" con email
- Se guarda en la BD (como antes)
- Se llama a la Edge Function `send-client-magic-link` automáticamente
- Se muestra un alert confirmando si el link se envió

**Flujo de mensajes:**
- ✅ Email guardado + link enviado → "Acceso guardado. Magic link enviado a..."
- ⚠️ Email guardado pero link falló → "Acceso guardado, pero no se pudo enviar el link: [error]"
- ✅ Sin email → "Acceso guardado (sin email de cliente)."

## Cómo probar

1. En el panel de agencia (index.html), abre un cliente existente
2. En la sección "Acceso del cliente", coloca un email válido
3. Marca o no "El cliente debe aprobar cada post"
4. Presiona "Guardar acceso"
5. Verás un alert confirmando si se envió
6. Revisa la bandeja de entrada (o spam) del email — debe llegar un email con el magic link
7. El cliente puede hacer clic y entra directo al panel sin escribir email

## Seguridad

- El magic link **expira en 24 horas** (configuración de Supabase Auth)
- Solo se envía si la agencia coloca un email válido (sin validación extra porque Supabase Auth la hace)
- La Edge Function tiene `verify_jwt: false` porque es llamada desde el frontend sin token, pero Supabase Auth maneja la seguridad internamente
- Si alguien intenta resend el magic link dos veces al mismo email, la segunda vez sobrescribe el primer link (comportamiento estándar)

## Qué pasa si el cliente no recibe el email

1. Revisar spam/promociones
2. Si no llega, el cliente puede:
   - Entrar a `cliente.html`
   - Poner su email
   - Presionar "Enviarme el link de acceso" (método manual sigue funcionando)
3. La agencia puede intentar presionar "Guardar acceso" de nuevo (genera un nuevo link)

## Notas

- El nombre "LaVisualMk" está hardcoded en la Edge Function (aparece en el subject del email). Si querés personalizarlo por cliente, se puede pasar como parámetro.
- El email de remitente es `lavisualmk@alastecno.com` (Hostinger SMTP)
- El redirect después de hacer clic en el link apunta a `cliente.html` automáticamente
