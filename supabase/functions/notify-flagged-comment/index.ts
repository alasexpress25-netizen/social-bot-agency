// supabase/functions/notify-flagged-comment/index.ts
//
// Propuesta 10 (PROPUESTAS-AGENCIA.md, 18/07/2026): apenas meta-webhook
// detecta un comentario con sentimiento negativo/queja y lo guarda en
// socialbot_flagged_comments (en vez de autoresponder), le manda un email
// inmediato a la agencia -- mismo patron que notify-hot-lead.ts, disparado
// por el trigger trg_notify_agency_flagged_comment (0022_flagged_comments.sql)
// via pg_net.
//
// verify_jwt=false, mismo motivo que notify-hot-lead/notify-pending-post:
// quien llama es el propio Postgres (via pg_net), no un usuario autenticado.
//
// Requiere los mismos secrets SMTP que notify-hot-lead (se pueden copiar
// tal cual desde esa funcion en el dashboard de Supabase):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (opcional)
// Opcionalmente AGENCY_PANEL_URL para incluir el link al panel en el email.
//
// Si faltan las credenciales SMTP, no rompe nada: solo loguea y no manda
// el email (mismo criterio de "fallback silencioso" que el resto del
// proyecto).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SMTP_HOST = Deno.env.get("SMTP_HOST") || "smtp.hostinger.com";
const SMTP_PORT = parseInt(Deno.env.get("SMTP_PORT") || "465");
const SMTP_USER = Deno.env.get("SMTP_USER");
const SMTP_PASS = Deno.env.get("SMTP_PASS");
const SMTP_FROM = Deno.env.get("SMTP_FROM") || SMTP_USER;
const AGENCY_PANEL_URL = Deno.env.get("AGENCY_PANEL_URL") || "";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: { flagged_comment_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("body invalido", { status: 400 });
  }

  const flaggedId = body.flagged_comment_id;
  if (!flaggedId) return new Response("falta flagged_comment_id", { status: 400 });

  if (!SMTP_USER || !SMTP_PASS) {
    console.log(`SMTP_USER/SMTP_PASS no configurados, se omite el email para flagged_comment ${flaggedId}.`);
    return new Response("ok (sin email, faltan credenciales SMTP)", { status: 200 });
  }

  const { data: flagged, error } = await supabase
    .from("socialbot_flagged_comments")
    .select("id, platform, text, reason, sender_id, client_id, socialbot_clients(name, agency_id)")
    .eq("id", flaggedId)
    .maybeSingle();

  if (error || !flagged) {
    console.error("No se encontro el comentario marcado", flaggedId, error);
    return new Response("flagged_comment no encontrado", { status: 200 });
  }

  const client = (flagged as any).socialbot_clients;
  if (!client?.agency_id) {
    return new Response("flagged_comment sin cliente/agencia asociada, se omite", { status: 200 });
  }

  const { data: agency } = await supabase
    .from("socialbot_agencies")
    .select("owner_user_id")
    .eq("id", client.agency_id)
    .maybeSingle();

  if (!agency?.owner_user_id) {
    return new Response("agencia sin owner, se omite", { status: 200 });
  }

  const { data: ownerUser, error: ownerError } = await supabase.auth.admin.getUserById(agency.owner_user_id);
  const ownerEmail = ownerUser?.user?.email;
  if (ownerError || !ownerEmail) {
    console.error("No se pudo resolver el email de la agencia", ownerError);
    return new Response("sin email de agencia, se omite", { status: 200 });
  }

  const panelLine = AGENCY_PANEL_URL
    ? `Entrá a revisarlo desde el panel: ${AGENCY_PANEL_URL}`
    : "Entrá a tu panel de siempre para revisarlo y responderlo a mano.";

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
      to: ownerEmail,
      subject: `⚠️ Comentario que requiere atención${client.name ? " — " + client.name : ""}`,
      content:
        `Hola!\n\n` +
        `Llegó un comentario${client.name ? " en " + client.name : ""} que el bot NO respondió automáticamente porque parece una queja o tiene un tono negativo -- conviene que lo revisen a mano.\n\n` +
        `Plataforma: ${flagged.platform}\n` +
        `Motivo detectado: ${flagged.reason || "sin detalle"}\n` +
        `Mensaje original: "${(flagged.text || "").slice(0, 300)}"\n` +
        `\n${panelLine}\n\n` +
        `El bot no le mandó ninguna respuesta automática a este comentario -- queda esperando que alguien del equipo lo conteste directamente en la red social.`,
    });
    await client_smtp.close();
  } catch (e) {
    console.error("Error mandando el email por SMTP:", e);
    try { await client_smtp.close(); } catch (_) { /* ya estaba cerrado o nunca abrio */ }
  }

  return new Response("ok", { status: 200 });
});
