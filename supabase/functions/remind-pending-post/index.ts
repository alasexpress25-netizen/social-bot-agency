// supabase/functions/remind-pending-post/index.ts
//
// Propuesta 12 (PROPUESTAS-AGENCIA.md, 18/07/2026): recordatorio de posts
// pendientes de aprobacion. notify-pending-post (Fase 5) ya avisa al
// cliente APENAS se genera un post que necesita su aprobacion, pero si el
// cliente no lo revisa, hoy nadie vuelve a acordarselo -- el post queda
// esperando indefinidamente. Esta funcion corre de forma PERIODICA (via
// cron de GitHub Actions, igual que notify-stale-leads) y manda un segundo
// email de seguimiento a los posts que siguen 'pending' hace mas de
// PENDING_REMINDER_HOURS horas y todavia no recibieron recordatorio
// (approval_reminder_sent_at IS NULL, columna de 0023_pending_post_reminder.sql).
//
// No depende de ningun trigger de Postgres -- es publica (verify_jwt=false,
// mismo criterio que notify-stale-leads / meta-webhook) y se dispara por
// HTTP desde afuera, con un GET o POST simple, sin body.
//
// Requiere los mismos secrets SMTP que notify-pending-post (se pueden
// copiar tal cual desde esa funcion en el dashboard de Supabase):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (opcional)
// Opcionales:
//   PENDING_REMINDER_HOURS (default 24) -- a partir de cuantas horas sin
//     aprobar/rechazar se manda el recordatorio.
//   CLIENT_PORTAL_URL -- se incluye en el cuerpo del mail si esta seteada
//     (mismo secret que ya usa notify-pending-post).
//
// Si no hay ningun post pendiente que cumpla el umbral, no manda ningun
// email (mismo criterio de "sin ruido" que notify-stale-leads).
//
// NOTA: esta funcion y la migracion que la acompaña (columna
// approval_reminder_sent_at en socialbot_posts) ya estaban deployadas y
// activas en produccion (redaqqxoeciycqgjhpbv) antes de bajar este ZIP --
// se hicieron en otra sesion que no habia quedado reflejada en el repo. Este
// archivo se agrega ahora solo para que el repo local quede fiel a lo que
// ya esta corriendo (mismo criterio que la nota de 0009_agency_approval_and_pending_notification.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SMTP_HOST = Deno.env.get("SMTP_HOST") || "smtp.hostinger.com";
const SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") || "465");
const SMTP_USER = Deno.env.get("SMTP_USER");
const SMTP_PASS = Deno.env.get("SMTP_PASS");
const SMTP_FROM = Deno.env.get("SMTP_FROM") || SMTP_USER;
const CLIENT_PORTAL_URL = Deno.env.get("CLIENT_PORTAL_URL") || "";
const PENDING_REMINDER_HOURS = parseInt(Deno.env.get("PENDING_REMINDER_HOURS") || "24");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function hoursSince(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!SMTP_USER || !SMTP_PASS) {
    console.log("SMTP_USER/SMTP_PASS no configurados, se omite el chequeo de posts pendientes.");
    return new Response("ok (sin email, faltan credenciales SMTP)", { status: 200 });
  }

  const cutoffIso = new Date(Date.now() - PENDING_REMINDER_HOURS * 3600000).toISOString();

  const { data: pendingPosts, error } = await supabase
    .from("socialbot_posts")
    .select("id, caption, created_at, client_id, socialbot_clients(name, client_email)")
    .eq("approval_status", "pending")
    .is("approval_reminder_sent_at", null)
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error consultando posts pendientes:", error);
    return new Response("error consultando posts", { status: 500 });
  }

  if (!pendingPosts || pendingPosts.length === 0) {
    return new Response("ok (sin posts pendientes que necesiten recordatorio)", { status: 200 });
  }

  const portalLine = CLIENT_PORTAL_URL
    ? `Podés revisarlo y aprobarlo (o editarlo) acá: ${CLIENT_PORTAL_URL}`
    : "Entrá a tu panel de siempre para revisarlo y aprobarlo.";

  let remindersSent = 0;

  for (const post of pendingPosts) {
    const client = (post as any).socialbot_clients;
    if (!client?.client_email) {
      // Cliente sin portal activado (o sin email cargado) -- nada que
      // recordar, pero igual marcamos como "enviado" para no reintentar
      // este post en cada corrida del cron.
      await supabase
        .from("socialbot_posts")
        .update({ approval_reminder_sent_at: new Date().toISOString() })
        .eq("id", post.id);
      continue;
    }

    const preview = (post.caption || "").slice(0, 220);
    const waitingHours = hoursSince(post.created_at);

    const client_smtp = new SMTPClient({
      connection: {
        hostname: SMTP_HOST,
        port: SMTP_PORT,
        tls: true,
        auth: { username: SMTP_USER, password: SMTP_PASS },
      },
    });

    try {
      await client_smtp.send({
        from: SMTP_FROM!,
        to: client.client_email,
        subject: `Recordatorio: post esperando tu aprobación${client.name ? " — " + client.name : ""}`,
        content:
          `Hola!\n\n` +
          `Este post${client.name ? " de " + client.name : ""} sigue esperando tu aprobación desde hace ${waitingHours}hs -- todavía no se publicó porque falta tu ok.\n\n` +
          `Texto propuesto:\n"${preview}${preview.length === 220 ? "..." : ""}"\n\n` +
          `${portalLine}\n\n` +
          `Si preferís que lo descartemos, también podés rechazarlo desde ahí.`,
      });
      await supabase
        .from("socialbot_posts")
        .update({ approval_reminder_sent_at: new Date().toISOString() })
        .eq("id", post.id);
      remindersSent++;
    } catch (e) {
      console.error(`Error mandando el recordatorio del post ${post.id}:`, e);
      // No marcamos approval_reminder_sent_at si fallo el envio -- se
      // reintenta en la proxima corrida del cron.
    } finally {
      try { await client_smtp.close(); } catch (_) { /* ya estaba cerrado o nunca abrio */ }
    }
  }

  return new Response(`ok (${remindersSent} recordatorio(s) enviado(s) de ${pendingPosts.length} post(s) pendiente(s))`, { status: 200 });
});
