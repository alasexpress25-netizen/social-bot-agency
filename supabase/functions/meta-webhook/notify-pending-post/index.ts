// supabase/functions/notify-pending-post/index.ts
//
// FASE 5: manda un email al cliente cuando el scheduler genera un post que
// queda esperando su aprobacion (require_approval=true). La dispara un
// trigger de Postgres (trg_notify_client_pending_post, en la migracion
// 0009_agency_approval_and_pending_notification.sql) via pg_net cada vez
// que se inserta un post con approval_status='pending'.
//
// verify_jwt=false porque quien llama es el propio Postgres (via pg_net),
// no un usuario autenticado -- mismo criterio que meta-webhook, que tambien
// es publico y no depende de un JWT de Supabase para validarse.
//
// Manda el email por SMTP directo contra el correo de Hostinger (el mismo
// que ya usa la agencia, lavisualmk@alastecno.com) -- no depende de ningun
// servicio de terceros. Requiere estos secrets (Supabase Dashboard >
// Edge Functions > notify-pending-post > Secrets):
//   SMTP_HOST = smtp.hostinger.com
//   SMTP_PORT = 465
//   SMTP_USER = lavisualmk@alastecno.com
//   SMTP_PASS = <la contrasena de ese correo>
//   SMTP_FROM = lavisualmk@alastecno.com   (opcional, si no se setea usa SMTP_USER)
// Opcionalmente tambien CLIENT_PORTAL_URL con la URL publica de
// frontend/cliente.html, para incluirla en el cuerpo del mail.
//
// Si faltan las credenciales SMTP, la funcion no rompe nada: solo loguea y
// no manda el email (mismo criterio de "fallback silencioso" que el resto
// del proyecto, ej. cuando falta GROQ_API_KEY en el webhook).

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

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: { post_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("body invalido", { status: 400 });
  }

  const postId = body.post_id;
  if (!postId) return new Response("falta post_id", { status: 400 });

  if (!SMTP_USER || !SMTP_PASS) {
    console.log(`SMTP_USER/SMTP_PASS no configurados, se omite el email para post ${postId}.`);
    return new Response("ok (sin email, faltan credenciales SMTP)", { status: 200 });
  }

  const { data: post, error } = await supabase
    .from("socialbot_posts")
    .select("id, caption, client_id, socialbot_clients(name, client_email)")
    .eq("id", postId)
    .maybeSingle();

  if (error || !post) {
    console.error("No se encontro el post", postId, error);
    return new Response("post no encontrado", { status: 200 });
  }

  const client = (post as any).socialbot_clients;
  if (!client?.client_email) {
    // Cliente sin portal activado (o sin email cargado) -- nada que notificar.
    return new Response("cliente sin email de portal, se omite", { status: 200 });
  }

  const preview = (post.caption || "").slice(0, 220);
  const portalLine = CLIENT_PORTAL_URL
    ? `Podés revisarlo y aprobarlo (o editarlo) acá: ${CLIENT_PORTAL_URL}`
    : "Entrá a tu panel de siempre para revisarlo y aprobarlo.";

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
      subject: `Tenés un post esperando tu aprobación${client.name ? " — " + client.name : ""}`,
      content:
        `Hola!\n\n` +
        `Se generó un nuevo post${client.name ? " para " + client.name : ""} y está esperando tu aprobación antes de publicarse.\n\n` +
        `Texto propuesto:\n"${preview}${preview.length === 220 ? "..." : ""}"\n\n` +
        `${portalLine}\n\n` +
        `Si no lo revisás, el post no se publica solo -- queda esperando tu decisión.`,
    });
    await client_smtp.close();
  } catch (e) {
    console.error("Error mandando el email por SMTP:", e);
    try { await client_smtp.close(); } catch (_) { /* ya estaba cerrado o nunca abrio */ }
  }

  return new Response("ok", { status: 200 });
});
