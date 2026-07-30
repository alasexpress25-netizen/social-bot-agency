// supabase/functions/notify-referral-suggestion/index.ts
//
// Punto 8 de propuestas-30-07-2026.md (Fase 7.6 del roadmap propio):
// apenas un lead pasa a 'convertido' y se arma una sugerencia de mensaje
// de referido/reseña (socialbot_referral_suggestions, status='proposed'),
// le avisa por mail a la agencia para que la revise y apruebe -- mismo
// patron que notify-hot-lead y notify-flagged-comment. Disparado por el
// trigger trg_create_referral_suggestion (0030_referral_suggestions.sql)
// via pg_net.
//
// Importante: esta funcion SOLO avisa. Nunca manda el mensaje al lead --
// eso lo hace send-referral-prompt, y solo despues de que la agencia
// aprueba la sugerencia desde el panel.
//
// verify_jwt=false, mismo motivo que el resto de las notify-*: quien
// llama es el propio Postgres (via pg_net), no un usuario autenticado.
//
// Requiere los mismos secrets SMTP que notify-hot-lead (se pueden copiar
// tal cual desde esa funcion en el dashboard de Supabase):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (opcional)
// Opcionalmente AGENCY_PANEL_URL para incluir el link al panel en el email.
//
// Si faltan las credenciales SMTP, no rompe nada: solo loguea y no manda
// el email (mismo criterio de "fallback silencioso" que el resto del
// proyecto). La sugerencia queda igual disponible en el panel aunque el
// mail no se mande.

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

  let body: { suggestion_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("body invalido", { status: 400 });
  }

  const suggestionId = body.suggestion_id;
  if (!suggestionId) return new Response("falta suggestion_id", { status: 400 });

  if (!SMTP_USER || !SMTP_PASS) {
    console.log(`SMTP_USER/SMTP_PASS no configurados, se omite el email para suggestion ${suggestionId}.`);
    return new Response("ok (sin email, faltan credenciales SMTP)", { status: 200 });
  }

  const { data: suggestion, error } = await supabase
    .from("socialbot_referral_suggestions")
    .select("id, message, platform, client_id, lead_id, socialbot_clients(name, agency_id), socialbot_leads(name, contact, interest)")
    .eq("id", suggestionId)
    .maybeSingle();

  if (error || !suggestion) {
    console.error("No se encontro la sugerencia de referido", suggestionId, error);
    return new Response("sugerencia no encontrada", { status: 200 });
  }

  const client = (suggestion as any).socialbot_clients;
  const lead = (suggestion as any).socialbot_leads;
  if (!client?.agency_id) {
    return new Response("sugerencia sin cliente/agencia asociada, se omite", { status: 200 });
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
    ? `Revisala, editala si hace falta, y aprobala desde el panel (pestaña Referidos): ${AGENCY_PANEL_URL}`
    : "Revisala, editala si hace falta, y aprobala desde el panel (pestaña Referidos).";

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
      subject: `🙌 Lead convertido${client.name ? " — " + client.name : ""}: sugerencia de referido lista para revisar`,
      content:
        `Hola!\n\n` +
        `${lead?.name || "Un lead"}${client.name ? " de " + client.name : ""} pasó a 'convertido' -- es un buen momento para pedirle una reseña o un referido.\n\n` +
        `Ya armamos un mensaje sugerido, pero NO se manda solo -- necesita tu aprobación:\n\n` +
        `"${suggestion.message}"\n\n` +
        `Contacto del lead: ${lead?.contact || "sin contacto directo"} (${suggestion.platform})\n\n` +
        `${panelLine}\n\n` +
        `Podés editar el texto antes de aprobar si no te convence como quedó.`,
    });
    await client_smtp.close();
  } catch (e) {
    console.error("Error mandando el email por SMTP:", e);
    try { await client_smtp.close(); } catch (_) { /* ya estaba cerrado o nunca abrio */ }
  }

  return new Response("ok", { status: 200 });
});
