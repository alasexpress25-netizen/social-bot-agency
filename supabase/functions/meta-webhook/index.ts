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
const GROQ_API_KEY = Deno.env.get("GROQ_API_KEY"); // opcional: si no esta seteada, se usa siempre el fallback de plantilla
const GRAPH_API_VERSION = "v21.0";

// Modelo gratuito y rapido de Groq. Se puede cambiar sin tocar el resto del
// codigo si el dia de mañana Groq cambia su catalogo de modelos free tier.
const GROQ_MODEL = "llama-3.1-8b-instant";

// Limite global por defecto si el cliente no tiene uno propio configurado en
// socialbot_ai_settings.daily_ai_reply_limit
const DEFAULT_DAILY_AI_LIMIT = 30;

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
    .select("*, socialbot_clients(*, socialbot_ai_settings(*))")
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
// FASE 1: uso prudente de IA (Groq free tier), con cache y limite diario.
// ---------------------------------------------------------------------------

function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // saca acentos para agrupar mejor variantes
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function getCachedReply(clientId: string, normalized: string): Promise<string | null> {
  const { data } = await supabase
    .from("socialbot_ai_reply_cache")
    .select("id, reply, hits")
    .eq("client_id", clientId)
    .eq("question_normalized", normalized)
    .maybeSingle();

  if (!data) return null;

  // Suma un hit, no cuenta como uso de cuota de IA (justamente para eso existe el cache).
  await supabase
    .from("socialbot_ai_reply_cache")
    .update({ hits: (data.hits ?? 0) + 1 })
    .eq("id", data.id);

  return data.reply;
}

async function saveCachedReply(clientId: string, normalized: string, reply: string) {
  // upsert: si dos eventos casi simultaneos generan la misma pregunta, no rompe por el unique(client_id, question_normalized)
  await supabase
    .from("socialbot_ai_reply_cache")
    .upsert(
      { client_id: clientId, question_normalized: normalized, reply, hits: 1 },
      { onConflict: "client_id,question_normalized" },
    );
}

async function getTodayUsage(clientId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (fecha del servidor; ok para un limite prudente, no necesita ser exacto por TZ del cliente)
  const { data } = await supabase
    .from("socialbot_ai_usage_log")
    .select("call_count")
    .eq("client_id", clientId)
    .eq("usage_date", today)
    .maybeSingle();
  return data?.call_count ?? 0;
}

async function incrementUsage(clientId: string) {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from("socialbot_ai_usage_log")
    .select("id, call_count")
    .eq("client_id", clientId)
    .eq("usage_date", today)
    .maybeSingle();

  if (data) {
    await supabase
      .from("socialbot_ai_usage_log")
      .update({ call_count: data.call_count + 1, updated_at: new Date().toISOString() })
      .eq("id", data.id);
  } else {
    await supabase
      .from("socialbot_ai_usage_log")
      .insert({ client_id: clientId, usage_date: today, call_count: 1 });
  }
}

async function callGroq(aiSettings: any, salesLink: string | null, incomingText: string): Promise<string | null> {
  if (!GROQ_API_KEY) return null; // sin API key configurada, directo al fallback

  const maxChars = aiSettings?.max_chars ?? 400;
  const basePrompt = aiSettings?.system_prompt ??
    "Sos un community manager. Escribí un post corto, atractivo, con emojis moderados y un llamado a la acción claro.";

  const systemPrompt = [
    basePrompt,
    aiSettings?.topics ? `Temas del negocio: ${aiSettings.topics}.` : null,
    aiSettings?.tone ? `Tono a usar: ${aiSettings.tone}.` : null,
    salesLink ? `Si tiene sentido, invitá a visitar: ${salesLink}.` : null,
    `Estás respondiendo un comentario o mensaje directo de un seguidor en redes sociales, no generando un post nuevo.`,
    `Respondé en portugués de Brasil, natural y cercano, como si fueras una persona real del equipo.`,
    `Máximo ${maxChars} caracteres. No uses markdown ni asteriscos.`,
  ]
    .filter(Boolean)
    .join(" ");

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: incomingText },
        ],
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    if (!res.ok) {
      console.error("Groq respondio con error:", res.status, await res.text());
      return null;
    }

    const json = await res.json();
    const reply: string | undefined = json?.choices?.[0]?.message?.content?.trim();
    if (!reply) return null;

    return reply.length > maxChars ? reply.slice(0, maxChars).trim() : reply;
  } catch (e) {
    console.error("Error llamando a Groq:", e);
    return null;
  }
}

// Intenta responder con IA. Devuelve null si hay que caer al fallback de
// palabra clave (limite superado, sin API key, o error de Groq).
async function tryAiReply(account: any, incomingText: string): Promise<{ reply: string; source: "ia" | "ia-cache" } | null> {
  const clientId = account.client_id;
  const aiSettings = account.socialbot_clients?.socialbot_ai_settings;
  const salesLink = account.socialbot_clients?.sales_link ?? null;

  const limit = aiSettings?.daily_ai_reply_limit || DEFAULT_DAILY_AI_LIMIT;

  const normalized = normalizeQuestion(incomingText);
  if (!normalized) return null;

  // El cache no cuenta contra el limite diario, se puede consultar siempre.
  const cached = await getCachedReply(clientId, normalized);
  if (cached) return { reply: cached, source: "ia-cache" };

  const usedToday = await getTodayUsage(clientId);
  if (usedToday >= limit) return null; // se paso del limite -> fallback a plantilla fija

  const aiReply = await callGroq(aiSettings, salesLink, incomingText);
  if (!aiReply) return null; // Groq fallo o no esta configurado -> fallback

  await incrementUsage(clientId);
  await saveCachedReply(clientId, normalized, aiReply);

  return { reply: aiReply, source: "ia" };
}

// ---------------------------------------------------------------------------
async function handleComment(params: { platform: string; pageId: string; commentId: string; text: string; senderId?: string }) {
  const { platform, pageId, commentId, text } = params;
  if (!commentId || (await alreadyHandled(platform, commentId))) return;

  const account = await findSocialAccountAndClient(platform, pageId);
  if (!account) return;

  let replyText: string | null = null;
  let matchedLabel: string | null = null;

  // 1) Primero se intenta con IA (si hay cuota y esta configurada)
  const aiResult = await tryAiReply(account, text);
  if (aiResult) {
    replyText = aiResult.reply;
    matchedLabel = aiResult.source; // "ia" o "ia-cache"
  } else {
    // 2) Fallback: matching de palabra clave con plantilla fija de siempre
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
    replyText = rule.reply_template.replace("{{sales_link}}", account.socialbot_clients?.sales_link ?? "");
    matchedLabel = rule.keyword;
  }

  const endpoint =
    platform === "facebook"
      ? `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/comments`
      : `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/replies`;

  await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: replyText, access_token: account.page_access_token }),
  });

  await logInteraction(account.client_id, platform, "comment", commentId, matchedLabel, true);
}

// ---------------------------------------------------------------------------
async function handleDm(params: { platform: string; pageId: string; senderId: string; text: string }) {
  const { platform, pageId, senderId, text } = params;
  const dmId = `${pageId}-${senderId}-${Date.now()}`; // los DMs no siempre traen un id unico util para dedupe estricto

  const account = await findSocialAccountAndClient(platform, pageId);
  if (!account) return;

  let replyText: string | null = null;
  let matchedLabel: string | null = null;

  // 1) Primero se intenta con IA (si hay cuota y esta configurada)
  const aiResult = await tryAiReply(account, text);
  if (aiResult) {
    replyText = aiResult.reply;
    matchedLabel = aiResult.source;
  } else {
    // 2) Fallback: matching de palabra clave con plantilla fija de siempre
    const { data: rules } = await supabase
      .from("socialbot_auto_reply_rules")
      .select("*")
      .eq("client_id", account.client_id)
      .in("match_type", ["dm", "both"]);

    const rule = matchKeyword(text, rules ?? []);
    if (!rule) return;

    replyText = rule.reply_template.replace("{{sales_link}}", account.socialbot_clients?.sales_link ?? "");
    matchedLabel = rule.keyword;
  }

  await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${account.page_access_token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: { text: replyText },
    }),
  });

  await logInteraction(account.client_id, platform, "dm", dmId, matchedLabel, true);
}
