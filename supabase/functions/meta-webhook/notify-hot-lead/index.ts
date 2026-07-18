// supabase/functions/notify-stale-leads/index.ts
//
// PRIORIDAD 1, punto 2 del roadmap (PROPUESTAS-AGENCIA.md): a diferencia de
// notify-hot-lead (que avisa AL INSTANTE cuando algo esta "listo para
// comprar"), esta funcion corre de forma PERIODICA (via cron de GitHub
// Actions, ver .github/workflows/stale-leads-check.yml) y junta en un solo
// email todos los leads que siguen en status='nuevo' (nadie los marco como
// contactado/convertido/descartado) hace mas de STALE_HOURS horas. Cubre
// las etapas que no ameritan una alarma inmediata (interesado/potencial)
// pero que igual se pueden estar enfriando sin que nadie se de cuenta.
//
// No depende de ningun trigger de Postgres -- es publica (verify_jwt=false,
// igual que meta-webhook) y se dispara por HTTP desde afuera, con un GET o
// POST simple, sin body.
//
// Requiere los mismos secrets SMTP que notify-hot-lead / notify-pending-post
// (se pueden copiar tal cual):
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM (opcional)
// Opcionales:
//   STALE_HOURS (default 24) -- a partir de cuantas horas sin contactar se
//     empieza a avisar.
//   AGENCY_PANEL_URL -- se incluye en el cuerpo del mail si esta seteada.
//
// Si un dia no hay ningun lead viejo sin contactar, no manda ningun email
// (no hace falta "ruido" confirmando que no hay nada pendiente).

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
const STALE_HOURS = parseInt(Deno.env.get("STALE_HOURS") || "24");

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

function cleanInterest(raw: string | null): string {
  return (raw || "").replace(/^\s*\[[a-z_]+\]\s*/i, "") || "sin detalle";
}

function hoursSince(iso: string): number {
  return Math.round((Date.now() - new Date(iso).getTime()) / 3600000);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST" && req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!SMTP_USER || !SMTP_PASS) {
    console.log("SMTP_USER/SMTP_PASS no configurados, se omite el chequeo de leads viejos.");
    return new Response("ok (sin email, faltan credenciales SMTP)", { status: 200 });
  }

  const cutoffIso = new Date(Date.now() - STALE_HOURS * 3600000).toISOString();

  const { data: staleLeads, error } = await supabase
    .from("socialbot_leads")
    .select("id, name, contact, platform, interest, created_at, client_id, socialbot_clients(name, agency_id)")
    .eq("status", "nuevo")
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true });

  if (error) {
    console.error("Error consultando leads viejos:", error);
    return new Response("error consultando leads", { status: 500 });
  }

  if (!staleLeads || staleLeads.length === 0) {
    return new Response("ok (sin leads viejos sin contactar)", { status: 200 });
  }

  // Agrupamos por agencia (por si en el futuro hay mas de una), y dentro de
  // cada agencia por cliente, para que el email quede prolijo.
  const byAgency = new Map<string, Map<string, { clientName: string; leads: any[] }>>();
  for (const lead of staleLeads) {
    const client = (lead as any).socialbot_clients;
    if (!client?.agency_id) continue;
    if (!byAgency.has(client.agency_id)) byAgency.set(client.agency_id, new Map());
    const byClient = byAgency.get(client.agency_id)!;
    if (!byClient.has(lead.client_id)) byClient.set(lead.client_id, { clientName: client.name || "cliente", leads: [] });
    byClient.get(lead.client_id)!.leads.push(lead);
  }

  let agenciesNotified = 0;

  for (const [agencyId, byClient] of byAgency) {
    const { data: agency } = await supabase
      .from("socialbot_agencies")
      .select("owner_user_id")
      .eq("id", agencyId)
      .maybeSingle();
    if (!agency?.owner_user_id) continue;

    const { data: ownerUser } = await supabase.auth.admin.getUserById(agency.owner_user_id);
    const ownerEmail = ownerUser?.user?.email;
    if (!ownerEmail) continue;

    let totalLeads = 0;
    const blocks: string[] = [];
    for (const { clientName, leads } of byClient.values()) {
      totalLeads += leads.length;
      const lines = leads.map((l: any) =>
        `  - ${l.name || "sin nombre"} (${l.platform}, ${l.contact || "sin contacto"}) -- "${cleanInterest(l.interest)}" -- hace ${hoursSince(l.created_at)}hs`
      ).join("\n");
      blocks.push(`${clientName}:\n${lines}`);
    }

    const panelLine = AGENCY_PANEL_URL
      ? `Entrá a revisarlos y marcarlos: ${AGENCY_PANEL_URL}`
      : "Entrá a tu panel de siempre para revisarlos y marcarlos.";

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
        subject: `📋 ${totalLeads} lead${totalLeads === 1 ? "" : "s"} sin contactar hace más de ${STALE_HOURS}hs`,
        content:
          `Hola!\n\n` +
          `Estos leads siguen marcados como "nuevo" hace más de ${STALE_HOURS} horas:\n\n` +
          blocks.join("\n\n") +
          `\n\n${panelLine}\n\n` +
          `Este aviso se manda una vez al día -- si ya contactaste a alguno, marcalo en el panel para que no vuelva a salir en la lista.`,
      });
      agenciesNotified++;
    } catch (e) {
      console.error("Error mandando el email por SMTP:", e);
    } finally {
      try { await client_smtp.close(); } catch (_) { /* ya estaba cerrado o nunca abrio */ }
    }
  }

  return new Response(`ok (${agenciesNotified} agencia(s) notificada(s), ${staleLeads.length} lead(s) viejos)`, { status: 200 });
});
