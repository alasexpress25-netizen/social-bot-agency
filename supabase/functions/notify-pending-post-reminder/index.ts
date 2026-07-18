// supabase/functions/notify-pending-post-reminder/index.ts
//
// Propuesta 12 (PROPUESTAS-AGENCIA.md, 18/07/2026): notify-pending-post
// (migracion 0009) ya avisa por email apenas se crea un post que necesita
// aprobacion, pero es un aviso UNICO -- si el cliente no entra a
// aprobarlo/rechazarlo, el post puede quedar esperando indefinidamente sin
// ningun segundo recordatorio.
//
// Esta funcion corre de forma PERIODICA (via cron de GitHub Actions, ver
// .github/workflows/pending_post_reminder.yml), no por un trigger de
// Postgres -- mismo patron que notify-stale-leads: es publica
// (verify_jwt=false) y se dispara por HTTP simple, sin body.
//
// Busca posts con approval_status='pending' creados hace mas de
// PENDING_REMINDER_HOURS horas Y que todavia no tengan
// reminder_sent_at seteado (para no mandar el mismo recordatorio dos
// veces). Manda un solo email de seguimiento por post y marca
// reminder_sent_at = now().
//
// Requiere los mismos secrets SMTP que notify-pending-post (se pueden
// copiar tal cual):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (opcional)
// Opcionales:
//   PENDING_REMINDER_HOURS (default 48) -- a partir de cuantas horas sin
//     aprobar/rechazar se manda el recordatorio.
//   CLIENT_PORTAL_URL -- se incluye en el cuerpo del mail si esta seteada
//     (mismo secret que ya usa notify-pending-post).
//
// Si no hay ningun post pendiente vencido, no manda ningun email.

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
const PENDING_REMINDER_HOURS = parseInt(Deno.env.get("PENDING_REMINDER_HOURS") || "48");

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

  const { data: posts, error } = await supabase
    .from("socialbot_posts")
    .select("id, caption, created_at, client_id, socialbot_clients(name, client_email)")
    .eq("approval_status", "pending")
    .is("reminder_sent_at", null)
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error consultando posts pendientes:", error);
    return new Response("error consultando posts", { status: 500 });
  }

  if (!posts || posts.length === 0) {
    return new Response("ok (sin posts pendientes vencidos)", { status: 200 });
  }

  const portalLine = CLIENT_PORTAL_URL
    ? `Podés revisarlo y aprobarlo (o editarlo) acá: ${CLIENT_PORTAL_URL}`
    : "Entrá a tu panel de siempre para revisarlo y aprobarlo.";

  let sent = 0;

  for (const post of posts) {
    const client = (post as any).socialbot_clients;
    if (!client?.client_email) {
      // Cliente sin portal activado (o sin email cargado) -- no hay a quien
      // avisarle, pero igual marcamos reminder_sent_at para no reintentar
      // este mismo post en cada corrida.
      await supabase.from("socialbot_posts").update({ reminder_sent_at: new Date().toISOString() }).eq("id", post.id);
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
        subject: `Recordatorio: post esperando tu aprobación hace ${waitingHours}hs${client.name ? " — " + client.name : ""}`,
        content:
          `Hola!\n\n` +
          `Este post${client.name ? " de " + client.name : ""} sigue esperando tu aprobación desde hace ${waitingHours} horas:\n\n` +
          `Texto propuesto:\n"${preview}${preview.length === 220 ? "..." : ""}"\n\n` +
          `${portalLine}\n\n` +
          `Si no lo revisás, el post sigue sin publicarse -- este es solo un recordatorio, no hace falta que respondas este email.`,
      });
      await supabase.from("socialbot_posts").update({ reminder_sent_at: new Date().toISOString() }).eq("id", post.id);
      sent++;
    } catch (e) {
      console.error(`Error mandando recordatorio para post ${post.id}:`, e);
      // No marcamos reminder_sent_at si el envio fallo -- se reintenta en
      // la proxima corrida del cron.
    } finally {
      try { await client_smtp.close(); } catch (_) { /* ya estaba cerrado o nunca abrio */ }
    }
  }

  return new Response(`ok (${sent} recordatorio(s) mandado(s) de ${posts.length} post(s) vencido(s))`, { status: 200 });
});
