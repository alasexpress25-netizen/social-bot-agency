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

// Datos de lead que puede devolver la IA en la misma llamada que genera la
// respuesta (Fase 2). Todo opcional: si no hay indicio de lead, is_hot=false.
interface LeadDetection {
  is_hot: boolean;
  name: string | null;
  contact: string | null;
  interest: string | null;
}

interface GroqReplyResult {
  reply: string;
  lead: LeadDetection | null;
}

async function callGroq(aiSettings: any, salesLink: string | null, incomingText: string): Promise<GroqReplyResult | null> {
  if (!GROQ_API_KEY) return null; // sin API key configurada, directo al fallback

  const maxChars = aiSettings?.max_chars ?? 400;
  const basePrompt = aiSettings?.system_prompt ??
    "Sos un community manager. Escribí un post corto, atractivo, con emojis moderados y un llamado a la acción claro.";

  // FASE 2: le pedimos a la IA que, en la misma respuesta, tambien califique
  // si el contacto es un lead caliente (interesado en comprar/contratar,
  // pidiendo precio, dejando telefono/email, etc.) y extraiga sus datos si
  // los menciono. No es una llamada extra: es el mismo request de Fase 1,
  // solo que ahora exigimos formato JSON con ambos campos.
  const systemPrompt = [
    basePrompt,
    aiSettings?.topics ? `Temas del negocio: ${aiSettings.topics}.` : null,
    aiSettings?.tone ? `Tono a usar: ${aiSettings.tone}.` : null,
    salesLink ? `Si tiene sentido, invitá a visitar: ${salesLink}.` : null,
    `Estás respondiendo un comentario o mensaje directo de un seguidor en redes sociales, no generando un post nuevo.`,
    `Respondé en portugués de Brasil, natural y cercano, como si fueras una persona real del equipo.`,
    `Máximo ${maxChars} caracteres para la respuesta. No uses markdown ni asteriscos.`,
    ``,
    `Además, evaluá si este contacto es un lead caliente: alguien que muestra intención real de compra/contratación (pregunta precio, disponibilidad, quiere agendar, dejó teléfono/email/usuario de contacto, dice "quiero comprar/contratar", etc.). Una pregunta genérica o un comentario de cortesía NO cuenta como lead caliente.`,
    `Respondé EXCLUSIVAMENTE con un JSON valido (sin texto antes ni despues, sin markdown, sin \`\`\`), con esta forma exacta:`,
    `{"reply": "<tu respuesta al usuario>", "lead": {"is_hot": true|false, "name": "<nombre si lo menciono, o null>", "contact": "<telefono/email/usuario si lo menciono, o null>", "interest": "<en pocas palabras que le interesa, o null>"}}`,
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
        max_tokens: 400,
        temperature: 0.7,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      console.error("Groq respondio con error:", res.status, await res.text());
      return null;
    }

    const json = await res.json();
    const rawContent: string | undefined = json?.choices?.[0]?.message?.content?.trim();
    if (!rawContent) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      // La IA no devolvio JSON valido (raro con response_format json_object,
      // pero puede pasar). Usamos el texto crudo como respuesta y sin lead,
      // en vez de tirar todo el intento a la basura.
      console.error("No se pudo parsear JSON de Groq, se usa texto crudo como reply:", rawContent);
      return { reply: rawContent.length > maxChars ? rawContent.slice(0, maxChars).trim() : rawContent, lead: null };
    }

    const reply: string | undefined = parsed?.reply?.trim();
    if (!reply) return null;

    const leadRaw = parsed?.lead;
    const lead: LeadDetection | null = leadRaw && leadRaw.is_hot
      ? {
          is_hot: true,
          name: leadRaw.name ?? null,
          contact: leadRaw.contact ?? null,
          interest: leadRaw.interest ?? null,
        }
      : null;

    return {
      reply: reply.length > maxChars ? reply.slice(0, maxChars).trim() : reply,
      lead,
    };
  } catch (e) {
    console.error("Error llamando a Groq:", e);
    return null;
  }
}

async function saveLead(clientId: string, platform: string, senderId: string, externalId: string | null, sourceText: string, lead: LeadDetection) {
  if (!senderId) return; // sin sender_id no hay a quien contactar despues, no vale la pena guardarlo

  // upsert: si el mismo contacto ya estaba guardado, actualizamos con los
  // datos mas recientes (puede haber completado nombre/telefono en un
  // mensaje posterior) sin duplicar filas.
  await supabase.from("socialbot_leads").upsert(
    {
      client_id: clientId,
      platform,
      sender_id: senderId,
      external_id: externalId,
      name: lead.name,
      contact: lead.contact,
      interest: lead.interest,
      source_text: sourceText,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_id,platform,sender_id" },
  );
}

// Intenta responder con IA. Devuelve null si hay que caer al fallback de
// palabra clave (limite superado, sin API key, o error de Groq).
//
// FASE 2: el `lead` solo viaja en la llamada "fresca" a Groq (source: "ia").
// Cuando la respuesta sale del cache (source: "ia-cache") no hay `lead`,
// porque el cache de Fase 1 solo guarda el texto de la respuesta, no la
// calificacion de lead -- y ademas no tendria sentido re-crear un lead
// identico cada vez que alguien repite la misma pregunta generica.
async function tryAiReply(account: any, incomingText: string): Promise<{ reply: string; source: "ia" | "ia-cache"; lead: LeadDetection | null } | null> {
  const clientId = account.client_id;
  const aiSettings = account.socialbot_clients?.socialbot_ai_settings;
  const salesLink = account.socialbot_clients?.sales_link ?? null;

  const limit = aiSettings?.daily_ai_reply_limit || DEFAULT_DAILY_AI_LIMIT;

  const normalized = normalizeQuestion(incomingText);
  if (!normalized) return null;

  // El cache no cuenta contra el limite diario, se puede consultar siempre.
  const cached = await getCachedReply(clientId, normalized);
  if (cached) return { reply: cached, source: "ia-cache", lead: null };

  const usedToday = await getTodayUsage(clientId);
  if (usedToday >= limit) return null; // se paso del limite -> fallback a plantilla fija

  const aiReply = await callGroq(aiSettings, salesLink, incomingText);
  if (!aiReply) return null; // Groq fallo o no esta configurado -> fallback

  await incrementUsage(clientId);
  await saveCachedReply(clientId, normalized, aiReply.reply);

  return { reply: aiReply.reply, source: "ia", lead: aiReply.lead };
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

    if (aiResult.lead?.is_hot) {
      await saveLead(account.client_id, platform, params.senderId ?? "", commentId, text, aiResult.lead);
    }
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

    if (aiResult.lead?.is_hot) {
      await saveLead(account.client_id, platform, senderId, null, text, aiResult.lead);
    }
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
