// supabase/functions/notify-hot-lead/index.ts
//
// Manda un email a la agencia (no al cliente) apenas entra un lead nuevo
// -- cualquier etapa del embudo -- para que se enteren sin tener que
// estar mirando el panel. Lo dispara un trigger de Postgres
// (trg_notify_agency_hot_lead, funcion notify_agency_hot_lead() en
// 0019_notify_hot_lead.sql / actualizada en
// 0028_notify_agency_any_new_lead.sql) via pg_net, mismo mecanismo que ya
// usa notify-pending-post para avisarle al cliente que tiene un post
// esperando aprobacion.
//
// Se dispara:
//   1) En cualquier lead INSERT (cualquier etapa: interesado, potencial,
//      listo_para_comprar) -- mismo criterio que usa el panel de Leads
//      del frontend, que muestra todos los leads sin filtrar por etapa.
//   2) En un UPDATE si el lead escala a "listo_para_comprar" y antes no
//      lo estaba -- se manda un segundo mail marcado como urgente.
//
// verify_jwt=false por el mismo motivo que meta-webhook y
// notify-pending-post: quien llama es el propio Postgres (via pg_net), no
// un usuario autenticado.
//
// Requiere estos secrets (Supabase Dashboard > Edge Functions >
// notify-hot-lead > Secrets) -- los mismos valores que ya tiene cargados
// notify-pending-post, se pueden copiar tal cual:
//   SMTP_HOST = smtp.hostinger.com
//   SMTP_PORT = 465
//   SMTP_USER = lavisualmk@alastecno.com
//   SMTP_PASS = <la contrasena de ese correo>
//   SMTP_FROM = lavisualmk@alastecno.com   (opcional, si no se setea usa SMTP_USER)
// Opcionalmente AGENCY_PANEL_URL con la URL publica del panel de la
// agencia, para incluirla en el cuerpo del mail.
//
// El destinatario principal es el email de login de la agencia
// (auth.users.email de socialbot_agencies.owner_user_id) -- no hace falta
// ninguna columna nueva, se resuelve con el admin client via service role.
//
// Ademas, si el cliente tiene cargado socialbot_clients.client_email, se
// le manda una segunda notificacion a el, con un texto distinto: mas
// formal, en lenguaje no tecnico, redactado como si lo escribiera la
// agencia avisandole que le llego un contacto nuevo interesado (sin el
// tono interno de "contactalo ya" ni las etiquetas de etapa/embudo que
// lleva el mail de la agencia). Si el cliente no tiene client_email
// cargado, simplemente se omite esa parte sin afectar el resto.
//
// Si faltan las credenciales SMTP, no rompe nada: solo loguea y no manda
// ningun email (mismo criterio de "fallback silencioso" que el resto del
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

// Etiquetas legibles para cada etapa del embudo (ver LeadStage en
// meta-webhook/index.ts). Se usan tanto en el asunto como en el cuerpo.
const STAGE_LABELS: Record<string, string> = {
  interesado: "Interesado",
  potencial: "Potencial",
  listo_para_comprar: "🔥 Listo para comprar",
  cliente_existente: "Cliente existente",
};

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: { lead_id?: string };
  try {
    body = await req.json();
  } catch {
    return new Response("body invalido", { status: 400 });
  }

  const leadId = body.lead_id;
  if (!leadId) return new Response("falta lead_id", { status: 400 });

  if (!SMTP_USER || !SMTP_PASS) {
    console.log(`SMTP_USER/SMTP_PASS no configurados, se omite el email para lead ${leadId}.`);
    return new Response("ok (sin email, faltan credenciales SMTP)", { status: 200 });
  }

  const { data: lead, error } = await supabase
    .from("socialbot_leads")
    .select("id, name, contact, platform, interest, source_text, post_permalink, post_id, client_id, socialbot_clients(name, agency_id, client_email)")
    .eq("id", leadId)
    .maybeSingle();

  if (error || !lead) {
    console.error("No se encontro el lead", leadId, error);
    return new Response("lead no encontrado", { status: 200 });
  }

  const client = (lead as any).socialbot_clients;
  if (!client?.agency_id) {
    return new Response("lead sin cliente/agencia asociada, se omite", { status: 200 });
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

  // El interest viene con el tag de etapa al principio (ej:
  // "[potencial] quiero un app"), lo separamos para el asunto/cuerpo.
  const stageMatch = (lead.interest || "").match(/^\s*\[([a-z_]+)\]\s*/i);
  const stageKey = stageMatch ? stageMatch[1].toLowerCase() : "";
  const stageLabel = STAGE_LABELS[stageKey] || "Nuevo lead";
  const isHottest = stageKey === "listo_para_comprar";
  const cleanInterest = (lead.interest || "").replace(/^\s*\[[a-z_]+\]\s*/i, "") || "sin detalle";
  const panelLine = AGENCY_PANEL_URL
    ? `Entrá a contactarlo desde el panel: ${AGENCY_PANEL_URL}`
    : "Entrá a tu panel de siempre para contactarlo.";

  const subjectIcon = isHottest ? "🔥" : "🆕";
  const subject = `${subjectIcon} Lead nuevo (${stageLabel})${client.name ? " — " + client.name : ""}`;
  const introLine = isHottest
    ? `Entró un lead en etapa LISTO PARA COMPRAR${client.name ? " para " + client.name : ""} y conviene contactarlo cuanto antes.`
    : `Entró un lead nuevo (etapa: ${stageLabel})${client.name ? " para " + client.name : ""}.`;
  const closingLine = isHottest
    ? "Los leads en esta etapa son los de mayor probabilidad de cierre -- cuanto antes se contacten, mejor conversión."
    : "Todavia no expreso intencion explicita de compra, pero vale la pena hacerle seguimiento.";

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
      subject,
      content:
        `Hola!\n\n` +
        `${introLine}\n\n` +
        `Plataforma: ${lead.platform}\n` +
        `Nombre: ${lead.name || "sin nombre"}\n` +
        `Contacto: ${lead.contact || "sin contacto directo"}\n` +
        `Interés: ${cleanInterest}\n` +
        `Mensaje original: "${(lead.source_text || "").slice(0, 220)}"\n` +
        (lead.post_permalink ? `Post de origen: ${lead.post_permalink}\n` : "") +
        `\n${panelLine}\n\n` +
        `${closingLine}`,
    });
    await client_smtp.close();
  } catch (e) {
    console.error("Error mandando el email por SMTP:", e);
    try { await client_smtp.close(); } catch (_) { /* ya estaba cerrado o nunca abrio */ }
  }

  // Segundo mail, para el cliente final (si tiene email cargado). Texto
  // distinto: formal, sin jerga tecnica ni etiquetas de etapa/embudo,
  // como si lo redactara la agencia avisandole que le entro un contacto
  // nuevo interesado en sus productos o servicios.
  const clientEmail = (client as any).client_email as string | null | undefined;
  if (clientEmail) {
    const client_smtp_2 = new SMTPClient({
      connection: {
        hostname: SMTP_HOST,
        port: SMTP_PORT,
        tls: true,
        auth: { username: SMTP_USER, password: SMTP_PASS },
      },
    });

    try {
      await client_smtp_2.send({
        from: SMTP_FROM!,
        to: clientEmail,
        subject: `Tenés un nuevo interesado${client.name ? " — " + client.name : ""}`,
        content:
          `Hola${client.name ? " " + client.name : ""},\n\n` +
          `Te escribimos desde La Visual MK para avisarte que te llegó un contacto nuevo a través de tus redes sociales, con interés en lo que ofrecés.\n\n` +
          `Estos son los datos que nos dejó:\n\n` +
          `Nombre: ${lead.name || "no lo dejó"}\n` +
          `Cómo contactarlo: ${lead.contact || "no dejó un contacto directo, podés responderle por el mismo canal"}\n` +
          `Interés en: ${cleanInterest}\n` +
          (lead.post_permalink ? `Publicación desde la que escribió: ${lead.post_permalink}\n` : "") +
          `\nTe recomendamos contactarlo lo antes posible, ya que las personas que se muestran interesadas suelen decidirse rápido.\n\n` +
          `Podés ver todos los detalles y el historial de la conversación en tu panel.\n\n` +
          `Saludos,\nLa Visual MK`,
      });
      await client_smtp_2.close();
    } catch (e) {
      console.error("Error mandando el email al cliente por SMTP:", e);
      try { await client_smtp_2.close(); } catch (_) { /* ya estaba cerrado o nunca abrio */ }
    }
  }

  return new Response("ok", { status: 200 });
});
