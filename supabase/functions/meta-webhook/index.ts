// supabase/functions/meta-webhook/index.ts
//
// Recibe los webhooks de Meta (comentarios en Facebook/Instagram y mensajes
// directos) y responde automaticamente cuando el texto contiene una palabra
// clave configurada para ese cliente en `auto_reply_rules`.
//
// Esta funcion necesita estar SIEMPRE disponible (no es un cron), por eso
// vive en Supabase Edge Functions (gratis, siempre "escuchando").
//
// Configurar en Meta App Dashboard > Webhooks:
//   Callback URL: https://<tu-proyecto>.supabase.co/functions/v1/meta-webhook
//   Verify Token: el mismo valor que pongas en META_WEBHOOK_VERIFY_TOKEN

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VERIFY_TOKEN = Deno.env.get("META_WEBHOOK_VERIFY_TOKEN")!;
const GRAPH_API_VERSION = "v21.0";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // --- 1) Verificacion del webhook (Meta hace un GET la primera vez) ---
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return new Response(challenge, { status: 200 });
    }
    return new Response("Forbidden", { status: 403 });
  }

  // --- 2) Eventos reales (comentarios / mensajes) ---
  if (req.method === "POST") {
    const body = await req.json();

    try {
      for (const entry of body.entry ?? []) {
        // Comentarios en Facebook / Instagram
        for (const change of entry.changes ?? []) {
          if (change.field === "feed" && change.value?.item === "comment") {
            await handleComment({
              platform: "facebook",
              pageId: entry.id,
              commentId: change.value.comment_id,
              text: change.value.message ?? "",
              senderId: change.value.from?.id,
            });
          }
          if (change.field === "comments") {
            await handleComment({
              platform: "instagram",
              pageId: entry.id,
              commentId: change.value.id,
              text: change.value.text ?? "",
              senderId: change.value.from?.id,
            });
          }
        }

        // Mensajes directos (Messenger / Instagram DM)
        for (const messaging of entry.messaging ?? []) {
          if (messaging.message?.text) {
            await handleDm({
              platform: "facebook",
              pageId: entry.id,
              senderId: messaging.sender.id,
              text: messaging.message.text,
            });
          }
        }
      }
    } catch (e) {
      console.error("Error procesando webhook:", e);
    }

    // Siempre responder 200 rapido para que Meta no reintente en loop
    return new Response("EVENT_RECEIVED", { status: 200 });
  }

  return new Response("Method not allowed", { status: 405 });
});

// ---------------------------------------------------------------------------
async function findSocialAccountAndClient(platform: string, pageId: string) {
  const { data } = await supabase
    .from("socialbot_social_accounts")
    .select("*, socialbot_clients(*)")
    .eq("platform", platform)
    .or(`page_id.eq.${pageId},ig_business_id.eq.${pageId}`)
    .limit(1)
    .maybeSingle();
  return data;
}

function matchKeyword(text: string, rules: any[]) {
  const lower = text.toLowerCase();
  return rules.find((r) => r.active && lower.includes(r.keyword.toLowerCase()));
}

async function alreadyHandled(platform: string, externalId: string) {
  const { data } = await supabase
    .from("socialbot_interactions_log")
    .select("id")
    .eq("platform", platform)
    .eq("external_id", externalId)
    .maybeSingle();
  return !!data;
}

async function logInteraction(clientId: string, platform: string, type: string, externalId: string, keyword: string | null, replied: boolean) {
  await supabase.from("socialbot_interactions_log").insert({
    client_id: clientId,
    platform,
    type,
    external_id: externalId,
    matched_keyword: keyword,
    replied,
  });
}

// ---------------------------------------------------------------------------
async function handleComment(params: { platform: string; pageId: string; commentId: string; text: string; senderId?: string }) {
  const { platform, pageId, commentId, text } = params;
  if (!commentId || (await alreadyHandled(platform, commentId))) return;

  const account = await findSocialAccountAndClient(platform, pageId);
  if (!account) return;

  const { data: rules } = await supabase
    .from("socialbot_auto_reply_rules")
    .select("*")
    .eq("client_id", account.client_id)
    .in("match_type", ["comment", "both"]);

  const rule = matchKeyword(text, rules ?? []);
  if (!rule) {
    await logInteraction(account.client_id, platform, "comment", commentId, null, false);
    return;
  }

  const replyText = rule.reply_template.replace("{{sales_link}}", account.socialbot_clients?.sales_link ?? "");

  const endpoint =
    platform === "facebook"
      ? `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/comments`
      : `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/replies`;

  await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: replyText, access_token: account.page_access_token }),
  });

  await logInteraction(account.client_id, platform, "comment", commentId, rule.keyword, true);
}

// ---------------------------------------------------------------------------
async function handleDm(params: { platform: string; pageId: string; senderId: string; text: string }) {
  const { platform, pageId, senderId, text } = params;
  const dmId = `${pageId}-${senderId}-${Date.now()}`; // los DMs no siempre traen un id unico util para dedupe estricto

  const account = await findSocialAccountAndClient(platform, pageId);
  if (!account) return;

  const { data: rules } = await supabase
    .from("socialbot_auto_reply_rules")
    .select("*")
    .eq("client_id", account.client_id)
    .in("match_type", ["dm", "both"]);

  const rule = matchKeyword(text, rules ?? []);
  if (!rule) return;

  const replyText = rule.reply_template.replace("{{sales_link}}", account.socialbot_clients?.sales_link ?? "");

  await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${account.page_access_token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: { text: replyText },
    }),
  });

  await logInteraction(account.client_id, platform, "dm", dmId, rule.keyword, true);
}
