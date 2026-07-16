// supabase/functions/meta-webhook/index.ts
//
// Recibe los webhooks de Meta (comentarios en Facebook/Instagram y mensajes
// directos) y responde automaticamente: primero intenta con IA (Groq, con
// cache y limite diario por cliente), despues cae a un fallback de palabra
// clave con plantilla fija (auto_reply_rules), y si TAMPOCO matchea ninguna
// keyword, cae a una respuesta de "piso" fija (sin costo de IA) para que
// ningun comentario/DM quede en silencio total.
//
// Esta funcion necesita estar SIEMPRE disponible (no es un cron), por eso
// vive en Supabase Edge Functions (gratis, siempre "escuchando").
//
// Configurar en Meta App Dashboard > Webhooks:
//   Callback URL: https://<tu-proyecto>.supabase.co/functions/v1/meta-webhook
//   Verify Token: el mismo valor que pongas en META_WEBHOOK_VERIFY_TOKEN
//
// NOTA (15/07/2026): esta version restaura la logica de IA (Fase 1) y de
// deteccion de leads (Fase 2), suma la "base de conocimiento" del negocio
// (knowledge_base), y CORRIGE UN BUCLE DE RESPUESTAS DUPLICADAS: la propia
// respuesta del bot es, para Meta, un comentario nuevo -- si no se filtra,
// el webhook de "comments" puede volver a dispararse para ESE comentario
// (hecho por la propia cuenta) y el bot termina respondiendose a si mismo
// en cadena. Se agregan dos protecciones:
//   1) Se ignora cualquier comentario/mensaje cuyo senderId sea la propia
//      cuenta (page_id / ig_business_id) -- nunca se responde a si mismo.
//   2) El comentario se "reserva" en socialbot_interactions_log ANTES de
//      generar la respuesta (insert con unique constraint), no despues.
//      Asi, si Meta reenvia el mismo evento casi al mismo tiempo (redelivery
//      por timeout, comun en webhooks), la segunda llamada lo ve ya
//      reservado y no dispara una segunda respuesta -- antes esta reserva
//      ocurria recien al final, dejando una ventana en la que dos llamadas
//      concurrentes podian pasar la validacion "ya fue manejado" y las dos
//      terminar respondiendo.
//
// NOTA (15/07/2026, mas tarde) -- respuesta de "piso": se detecto que un
// cliente real agoto su limite diario de IA (30/30) en unos minutos, y a
// partir de ahi CUALQUIER comentario que no matcheara una keyword de
// auto_reply_rules quedaba sin ninguna respuesta (silencio total) -- se vio
// en una captura real: varios comentarios/leads sin contestar. Se agrega un
// tercer nivel de fallback, sin costo de IA: socialbot_ai_settings.
// fallback_reply_template (o un texto generico por defecto si esta vacio),
// que se usa cuando no hay cuota de IA Y ninguna keyword matcheo. Asi ya no
// puede quedar un mensaje sin ningun tipo de respuesta.
//
// NOTA (16/07/2026): el idioma de respuesta estaba fijo en portugues de
// Brasil para TODOS los clientes (tenia sentido cuando el unico cliente con
// IA activa era Impacto 3D, 100% Brasil). Al sumar clientes bilingues
// (ej. Alas Tecno, que atiende Argentina y Brasil), se reemplaza por
// socialbot_ai_settings.reply_language: "pt-BR" o "es" fuerzan ese idioma
// siempre, "auto" hace que la IA detecte el idioma del mensaje entrante y
// responda en el mismo. Default "pt-BR" para no cambiar el comportamiento
// de clientes ya configurados antes de este campo.

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

// Texto generico usado como respuesta de "piso" cuando el cliente no cargo
// su propio fallback_reply_template. En portugues de Brasil, igual que el
// resto de las respuestas automaticas de este sistema.
const DEFAULT_FALLBACK_REPLY =
  "Obrigado pelo seu comentário! 🙌 Em breve alguém do nosso time te responde por aqui. Se quiser já ir adiantando, fala com a gente: {{sales_link}}";

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function debugLog(clientId: string | null, stage: string, detail: string) {
  try {
    await supabase.from("socialbot_ai_debug_log").insert({ client_id: clientId, stage, detail });
  } catch (_e) {
    // el debug log nunca debe romper el flujo principal
  }
}

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
      await debugLog(null, "top_level_error", String(e));
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

// Respuesta de piso: se usa cuando no matcheo ninguna keyword de
// auto_reply_rules Y ademas no hubo respuesta de IA (sin cuota, sin
// GROQ_API_KEY configurada, o error de Groq). No consume cuota de IA -- es
// una plantilla fija, igual que las reglas de palabra clave, para que nunca
// quede un mensaje sin ningun tipo de respuesta.
function buildFallbackReply(aiSettings: any, salesLink: string | null): string {
  const template = (aiSettings?.fallback_reply_template as string | null) || DEFAULT_FALLBACK_REPLY;
  return template.replace("{{sales_link}}", salesLink ?? "");
}

// Intenta "reservar" el comentario/mensaje ANTES de procesarlo (insert con
// la unique constraint (platform, external_id) de 0001_init.sql). Si ya
// existe (otra invocacion, ej. un reenvio del mismo evento por parte de
// Meta, ya lo reservo antes), el insert falla por conflicto y devolvemos
// false -- el caller debe cortar ahi, sin generar ni mandar otra respuesta.
// Esto reemplaza el chequeo previo (SELECT primero, INSERT despues al
// final), que dejaba una ventana de carrera entre dos invocaciones
// concurrentes procesando el mismo evento.
async function claimInteraction(clientId: string, platform: string, type: string, externalId: string): Promise<boolean> {
  const { error } = await supabase.from("socialbot_interactions_log").insert({
    client_id: clientId,
    platform,
    type,
    external_id: externalId,
    matched_keyword: null,
    replied: false,
  });
  // Codigo 23505 = unique_violation en Postgres -- ya estaba reservado.
  if (error) {
    if ((error as any).code === "23505") return false;
    console.error("Error reservando interaccion (se continua igual):", error);
  }
  return true;
}

async function finishInteraction(platform: string, externalId: string, keyword: string | null, replied: boolean) {
  await supabase
    .from("socialbot_interactions_log")
    .update({ matched_keyword: keyword, replied })
    .eq("platform", platform)
    .eq("external_id", externalId);
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

  await supabase
    .from("socialbot_ai_reply_cache")
    .update({ hits: (data.hits ?? 0) + 1 })
    .eq("id", data.id);

  return data.reply;
}

async function saveCachedReply(clientId: string, normalized: string, reply: string) {
  await supabase
    .from("socialbot_ai_reply_cache")
    .upsert(
      { client_id: clientId, question_normalized: normalized, reply, hits: 1 },
      { onConflict: "client_id,question_normalized" },
    );
}

async function getTodayUsage(clientId: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
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

async function callGroq(aiSettings: any, salesLink: string | null, incomingText: string, clientId: string): Promise<GroqReplyResult | null> {
  if (!GROQ_API_KEY) {
    await debugLog(clientId, "callGroq", "GROQ_API_KEY no esta seteada en los secrets de esta funcion");
    return null;
  }

  const maxChars = aiSettings?.max_chars ?? 400;
  const basePrompt = aiSettings?.system_prompt ??
    "Sos un community manager. Escribí un post corto, atractivo, con emojis moderados y un llamado a la acción claro.";

  const knowledgeBlock = aiSettings?.knowledge_base
    ? `Informacion real del negocio (usala como fuente de verdad; si la pregunta no esta cubierta aca, respondé de forma general sin inventar precios ni datos que no esten en este texto):\n${aiSettings.knowledge_base}`
    : null;

  // Idioma de respuesta por cliente (columna reply_language en
  // socialbot_ai_settings). "pt-BR"/"es" fuerzan ese idioma siempre
  // (clientes de un solo mercado); "auto" hace que la IA responda en el
  // mismo idioma en el que le escribieron (clientes bilingues, ej. Alas
  // Tecno que atiende Argentina y Brasil). Default "pt-BR" para no romper
  // el comportamiento de clientes ya configurados antes de este campo.
  const replyLanguage = aiSettings?.reply_language ?? "pt-BR";
  const languageInstruction = replyLanguage === "auto"
    ? `Detectá el idioma del mensaje entrante y respondé en ese mismo idioma (si te escriben en español, respondé en español; si te escriben en portugués, respondé en portugués de Brasil), natural y cercano, como si fueras el dueno/a del negocio respondiendo personalmente.`
    : replyLanguage === "es"
    ? `Respondé en español, natural y cercano, como si fueras el dueno/a del negocio respondiendo personalmente.`
    : `Respondé en portugués de Brasil, natural y cercano, como si fueras el dueno/a del negocio respondiendo personalmente.`;

  const systemPrompt = [
    basePrompt,
    aiSettings?.topics ? `Temas del negocio: ${aiSettings.topics}.` : null,
    aiSettings?.tone ? `Tono a usar: ${aiSettings.tone}.` : null,
    salesLink ? `Si tiene sentido, invitá a visitar: ${salesLink}.` : null,
    knowledgeBlock,
    `Estás respondiendo un comentario o mensaje directo de un seguidor en redes sociales, no generando un post nuevo.`,
    languageInstruction,
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
      const errText = await res.text();
      console.error("Groq respondio con error:", res.status, errText);
      await debugLog(clientId, "callGroq_http_error", `status=${res.status} body=${errText.slice(0, 500)}`);
      return null;
    }

    const json = await res.json();
    const rawContent: string | undefined = json?.choices?.[0]?.message?.content?.trim();
    if (!rawContent) {
      await debugLog(clientId, "callGroq_empty_content", JSON.stringify(json).slice(0, 500));
      return null;
    }

    let parsed: any;
    try {
      parsed = JSON.parse(rawContent);
    } catch {
      console.error("No se pudo parsear JSON de Groq, se usa texto crudo como reply:", rawContent);
      await debugLog(clientId, "callGroq_json_parse_fallback", rawContent.slice(0, 500));
      return { reply: rawContent.length > maxChars ? rawContent.slice(0, maxChars).trim() : rawContent, lead: null };
    }

    const reply: string | undefined = parsed?.reply?.trim();
    if (!reply) {
      await debugLog(clientId, "callGroq_no_reply_field", rawContent.slice(0, 500));
      return null;
    }

    const leadRaw = parsed?.lead;
    const lead: LeadDetection | null = leadRaw && leadRaw.is_hot
      ? {
          is_hot: true,
          name: leadRaw.name ?? null,
          contact: leadRaw.contact ?? null,
          interest: leadRaw.interest ?? null,
        }
      : null;

    await debugLog(clientId, "callGroq_ok", reply.slice(0, 200));

    return {
      reply: reply.length > maxChars ? reply.slice(0, maxChars).trim() : reply,
      lead,
    };
  } catch (e) {
    console.error("Error llamando a Groq:", e);
    await debugLog(clientId, "callGroq_exception", String(e));
    return null;
  }
}

async function saveLead(clientId: string, platform: string, senderId: string, externalId: string | null, sourceText: string, lead: LeadDetection) {
  if (!senderId) return;

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

async function tryAiReply(account: any, incomingText: string): Promise<{ reply: string; source: "ia" | "ia-cache"; lead: LeadDetection | null } | null> {
  const clientId = account.client_id;
  const aiSettings = account.socialbot_clients?.socialbot_ai_settings;
  const salesLink = account.socialbot_clients?.sales_link ?? null;

  const limit = aiSettings?.daily_ai_reply_limit || DEFAULT_DAILY_AI_LIMIT;

  const normalized = normalizeQuestion(incomingText);
  if (!normalized) return null;

  const cached = await getCachedReply(clientId, normalized);
  if (cached) return { reply: cached, source: "ia-cache", lead: null };

  const usedToday = await getTodayUsage(clientId);
  if (usedToday >= limit) {
    await debugLog(clientId, "limite_diario_alcanzado", `usedToday=${usedToday} limit=${limit}`);
    return null;
  }

  const aiReply = await callGroq(aiSettings, salesLink, incomingText, clientId);
  if (!aiReply) return null;

  await incrementUsage(clientId);
  await saveCachedReply(clientId, normalized, aiReply.reply);

  return { reply: aiReply.reply, source: "ia", lead: aiReply.lead };
}

// ---------------------------------------------------------------------------
async function handleComment(params: { platform: string; pageId: string; commentId: string; text: string; senderId?: string }) {
  const { platform, pageId, commentId, text, senderId } = params;
  if (!commentId) return;

  const account = await findSocialAccountAndClient(platform, pageId);
  if (!account) return;

  const aiSettings = account.socialbot_clients?.socialbot_ai_settings;
  const salesLink = account.socialbot_clients?.sales_link ?? null;

  // Nunca responder a un comentario hecho por la propia cuenta (evita el
  // bucle: la respuesta del bot es en si misma un comentario nuevo, que
  // Meta puede volver a mandar como evento "comments").
  if (senderId && (senderId === account.page_id || senderId === account.ig_business_id)) {
    return;
  }

  // Reserva atomica: si ya estaba reservado (por un reenvio del mismo
  // evento, o por esta misma pagina respondiendose en bucle a pesar del
  // filtro de arriba), se corta aca sin generar ni mandar nada.
  const claimed = await claimInteraction(account.client_id, platform, "comment", commentId);
  if (!claimed) return;

  let replyText: string | null = null;
  let matchedLabel: string | null = null;

  // 1) Primero se intenta con IA (si hay cuota y esta configurada)
  const aiResult = await tryAiReply(account, text);
  if (aiResult) {
    replyText = aiResult.reply;
    matchedLabel = aiResult.source; // "ia" o "ia-cache"

    if (aiResult.lead?.is_hot) {
      await saveLead(account.client_id, platform, senderId ?? "", commentId, text, aiResult.lead);
    }
  } else {
    // 2) Fallback: matching de palabra clave con plantilla fija de siempre
    const { data: rules } = await supabase
      .from("socialbot_auto_reply_rules")
      .select("*")
      .eq("client_id", account.client_id)
      .in("match_type", ["comment", "both"]);

    const rule = matchKeyword(text, rules ?? []);
    if (rule) {
      replyText = rule.reply_template.replace("{{sales_link}}", salesLink ?? "");
      matchedLabel = rule.keyword;
    } else {
      // 3) Respuesta de piso: ninguna keyword matcheo y no hubo IA (sin
      // cuota o sin configurar). Se manda igual una respuesta fija, sin
      // costo de IA, para que el comentario nunca quede sin contestar.
      replyText = buildFallbackReply(aiSettings, salesLink);
      matchedLabel = "fallback-piso";
    }
  }

  const endpoint =
    platform === "facebook"
      ? `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/comments`
      : `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/replies`;

  const replyResp = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ message: replyText, access_token: account.page_access_token }),
  });

  // Ademas del reply publico (que en Instagram queda oculto como "reply" anidado
  // y nunca tiene links/telefonos clickeables), mandamos el mismo mensaje como
  // "private reply": esto abre un DM con la persona que comento, donde el link
  // SI se ve clickeable. Es best-effort: si falla, no rompe el flujo principal.
  if (replyResp.ok) {
    try {
      await fetch(
        `https://graph.facebook.com/${GRAPH_API_VERSION}/${commentId}/private_replies`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ message: replyText, access_token: account.page_access_token }),
        },
      );
    } catch (e) {
      console.error("Error enviando private reply:", e);
    }
  }

  await finishInteraction(platform, commentId, matchedLabel, replyResp.ok);
}

// ---------------------------------------------------------------------------
async function handleDm(params: { platform: string; pageId: string; senderId: string; text: string }) {
  const { platform, pageId, senderId, text } = params;

  const account = await findSocialAccountAndClient(platform, pageId);
  if (!account) return;

  const aiSettings = account.socialbot_clients?.socialbot_ai_settings;
  const salesLink = account.socialbot_clients?.sales_link ?? null;

  // Nunca responder a un DM que en realidad mando la propia cuenta.
  if (senderId && (senderId === account.page_id || senderId === account.ig_business_id)) {
    return;
  }

  const dmId = `${pageId}-${senderId}-${Date.now()}`;

  const claimed = await claimInteraction(account.client_id, platform, "dm", dmId);
  if (!claimed) return;

  let replyText: string | null = null;
  let matchedLabel: string | null = null;

  const aiResult = await tryAiReply(account, text);
  if (aiResult) {
    replyText = aiResult.reply;
    matchedLabel = aiResult.source;

    if (aiResult.lead?.is_hot) {
      await saveLead(account.client_id, platform, senderId, null, text, aiResult.lead);
    }
  } else {
    const { data: rules } = await supabase
      .from("socialbot_auto_reply_rules")
      .select("*")
      .eq("client_id", account.client_id)
      .in("match_type", ["dm", "both"]);

    const rule = matchKeyword(text, rules ?? []);
    if (rule) {
      replyText = rule.reply_template.replace("{{sales_link}}", salesLink ?? "");
      matchedLabel = rule.keyword;
    } else {
      // Respuesta de piso, igual que en handleComment.
      replyText = buildFallbackReply(aiSettings, salesLink);
      matchedLabel = "fallback-piso";
    }
  }

  await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${account.page_access_token}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: senderId },
      message: { text: replyText },
    }),
  });

  await finishInteraction(platform, dmId, matchedLabel, true);
}
