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
// NOTA (20/07/2026): se agrega el chequeo de socialbot_clients.active en
// handleComment/handleDm -- si el cliente esta pausado (ej. no pago este
// mes), este webhook ya no gasta cuota de IA ni procesa nada para el hasta
// que se reactive desde el panel de agencia.

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
              senderName: change.value.from?.name ?? null,
              postId: change.value.post_id ?? null,
            });
          }
          if (change.field === "comments") {
            await handleComment({
              platform: "instagram",
              pageId: entry.id,
              commentId: change.value.id,
              text: change.value.text ?? "",
              senderId: change.value.from?.id,
              senderName: change.value.from?.username ?? change.value.from?.name ?? null,
              postId: change.value.media?.id ?? null,
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
async function claimInteraction(clientId: string, platform: string, type: string, externalId: string, senderId?: string | null): Promise<boolean> {
  const { error } = await supabase.from("socialbot_interactions_log").insert({
    client_id: clientId,
    platform,
    type,
    external_id: externalId,
    sender_id: senderId ?? null,
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

// "stage" = etapa del embudo comercial (vocabulario estandar de agencia):
//   "interesado"        -> mostro curiosidad / pregunta general, sin pedir precio.
//   "potencial"         -> pidio precio/disponibilidad/detalles, o dejo contacto.
//   "listo_para_comprar"-> intencion explicita de contratar/comprar YA.
//   "cliente_existente" -> ya es cliente (pide soporte, renovar, ampliar).
//   "no_lead"           -> sin señal de interes comercial (solo si is_hot=false).
type LeadStage = "interesado" | "potencial" | "listo_para_comprar" | "cliente_existente" | "no_lead";

interface LeadDetection {
  is_hot: boolean;
  name: string | null;
  contact: string | null;
  interest: string | null;
  stage: LeadStage | null;
}

interface GroqReplyResult {
  reply: string;
  lead: LeadDetection | null;
  sentiment: "negativo" | "neutral" | "positivo";
}

function buildLeadInstructions(topics: string | null): string {
  const topicsLine = topics
    ? `El rubro/los productos y servicios de este negocio son: ${topics}.`
    : `No hay informacion de rubro cargada para este negocio -- usa el contexto del mensaje.`;

  return [
    `TAREA CRITICA - DETECCION DE LEADS (tan importante como la respuesta en si, no la trates como secundaria):`,
    topicsLine,
    `Marca is_hot=true si el mensaje muestra CUALQUIERA de estas señales de interes comercial real (alcanza con UNA sola, no hace falta que se cumplan todas):`,
    `1) Pregunta si el negocio ofrece/tiene/hace/vende algo relacionado a su rubro (ej: "tienen apps?", "hacen paginas web?", "vocês fazem aplicativo?", "tem sistema pra restaurante?", "hacen envios a Cordoba?") -- estas preguntas SIEMPRE son lead, aunque sean cortas, informales o mal escritas.`,
    `2) Pregunta precio, presupuesto, costo, planes, valores, "cuanto sale/cuesta", "quanto custa/sai", cotizacion.`,
    `3) Pregunta disponibilidad, tiempos de entrega o de inicio, "en cuanto tiempo", "quando podem começar".`,
    `4) Expresa que quiere, necesita, busca, precisa o le interesa el producto/servicio ("quiero un app", "necesito una web", "preciso de um sistema", "estou procurando", "me interesa").`,
    `5) Deja espontaneamente un dato de contacto (telefono, email, usuario de otra red), aunque no se lo hayas pedido.`,
    `6) Pide hablar con alguien del equipo, agendar una llamada o reunion, o que lo contacten.`,
    `7) Dice que YA es cliente y quiere ampliar, renovar, agregar algo, o reporta un problema con algo que ya tiene contratado con este negocio -- esto TAMBIEN es lead (de tipo cliente existente), no lo descartes.`,
    `8) Compara con la competencia o pregunta si el negocio es mejor o distinto a otro similar.`,
    `9) Reacciona con intencion de avanzar frente a un post de producto/oferta ("sim, quero", "eu quero", "quiero saber mas", "me anoto").`,
    `NO marques is_hot=true SOLO en estos casos: un saludo sin pregunta, un elogio generico sin pedir nada ("lindo!", "que legal", "top demais"), una queja sin relacion al negocio, spam/publicidad de un tercero, o un comentario sin ninguna relacion con lo que vende el negocio.`,
    `Ante la duda entre lead y no-lead, marca is_hot=true: preferimos que un humano revise y descarte un lead de mas, antes que perder un cliente real por no haberlo marcado.`,
    `Ademas de is_hot, clasifica el mensaje en "stage" (etapa del embudo comercial), usando EXACTAMENTE uno de estos valores:`,
    `- "interesado": mostro curiosidad o hizo una pregunta general sobre el producto/servicio, sin pedir precio ni avanzar en la compra.`,
    `- "potencial": pidio precio, disponibilidad, detalles concretos, o dejo datos de contacto -- esta calificado para que un vendedor humano lo contacte.`,
    `- "listo_para_comprar": expreso intencion explicita de contratar/comprar YA, o pidio agendar/hablar con alguien.`,
    `- "cliente_existente": el mensaje deja en claro que YA es cliente del negocio (habla de algo que ya tiene contratado, pide soporte, quiere renovar o ampliar).`,
    `- "no_lead": no hay ninguna señal de interes comercial real (usar SOLO si is_hot es false).`,
    `Regla de consistencia: si "stage" es distinto de "no_lead", is_hot DEBE ser true. Si is_hot es true, "stage" NO puede ser "no_lead" (usa "interesado" como piso).`,
  ].join(" ");
}

function buildComplaintInstructions(): string {
  return [
    `Ademas, clasifica el "sentiment" general del mensaje en EXACTAMENTE uno de estos valores:`,
    `- "negativo": el mensaje es una queja, reclamo, critica, o expresa enojo/frustracion/decepcion (con el negocio, con un pedido, con una entrega, con la calidad de algo, etc.), sea o no relacionado directamente al rubro del negocio.`,
    `- "positivo": el mensaje es un elogio, agradecimiento, o reaccion claramente favorable.`,
    `- "neutral": no es ni queja ni elogio (pregunta comun, saludo, comentario sin carga emocional).`,
    `Un mensaje puede ser is_hot=false Y sentiment="negativo" al mismo tiempo (ej: una queja sin relacion al negocio sigue siendo is_hot=false, pero sentiment="negativo").`,
  ].join(" ");
}

const BUYING_PHRASES = [
  // Español
  "precio", "presupuesto", "cotizacion", "cotización", "cuanto sale", "cuánto sale",
  "cuanto cuesta", "cuánto cuesta", "quiero", "necesito", "busco", "me interesa",
  "estoy interesado", "estoy interesada", "disponibilidad", "cuando pueden", "cuándo pueden",
  "hablar con alguien", "agendar", "una llamada", "una reunion", "una reunión",
  "contratar", "comprar", "ya soy cliente", "soy cliente", "tengo contratado", "soporte",
  "renovar", "ampliar",
  // Português
  "preço", "preco", "orçamento", "orcamento", "cotação", "cotacao", "quanto custa",
  "quanto sai", "quero", "preciso", "procuro", "interessado", "interessada",
  "disponibilidade", "quando podem", "falar com alguem", "falar com alguém", "uma reuniao",
  "uma reunião", "ja sou cliente", "já sou cliente", "tenho contratado", "suporte",
];

const OFFER_QUESTION_WORDS = [
  "tienen", "tenes", "tenés", "hacen", "hacés", "haces", "venden", "vendes", "ofrecen",
  "tem", "têm", "fazem", "vendem", "trabalham com",
];

const CONTACT_REGEX = /([\w.+-]+@[\w-]+\.[a-z]{2,})|(\+?\d[\d\s().-]{7,}\d)/i;

function extractTopicWords(topics: string | null): string[] {
  if (!topics) return [];
  return topics
    .toLowerCase()
    .split(/[,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2);
}

function heuristicLeadDetection(text: string, topics: string | null): LeadDetection | null {
  const lower = text.toLowerCase();
  const hasBuyingPhrase = BUYING_PHRASES.some((p) => lower.includes(p));
  const hasContact = CONTACT_REGEX.test(text);

  const topicWords = extractTopicWords(topics);
  const mentionsTopic = topicWords.some((t) => lower.includes(t));
  const asksAboutOffer = mentionsTopic && OFFER_QUESTION_WORDS.some((w) => lower.includes(w));

  if (!hasBuyingPhrase && !hasContact && !asksAboutOffer) return null;

  let stage: LeadStage = "interesado";
  if (hasContact) stage = "potencial";
  if (lower.includes("contratar") || lower.includes("comprar") || lower.includes("agendar")) {
    stage = "listo_para_comprar";
  }
  if (
    lower.includes("ya soy cliente") || lower.includes("soy cliente") ||
    lower.includes("ja sou cliente") || lower.includes("já sou cliente") ||
    lower.includes("tengo contratado") || lower.includes("tenho contratado")
  ) {
    stage = "cliente_existente";
  }

  return {
    is_hot: true,
    name: null,
    contact: hasContact ? (text.match(CONTACT_REGEX)?.[0] ?? null) : null,
    interest: text.slice(0, 200),
    stage,
  };
}

const DEFAULT_ANTI_SPAM_HOURLY_LIMIT = 5;

async function isSenderSpamming(clientId: string, senderId: string | undefined | null, aiSettings: any): Promise<boolean> {
  if (!senderId) return false;
  const limit = aiSettings?.anti_spam_hourly_limit || DEFAULT_ANTI_SPAM_HOURLY_LIMIT;
  const sinceIso = new Date(Date.now() - 3600000).toISOString();

  const { count, error } = await supabase
    .from("socialbot_interactions_log")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("sender_id", senderId)
    .gte("created_at", sinceIso);

  if (error) {
    console.error("Error chequeando anti-spam por remitente (se continua igual):", error);
    return false;
  }

  return (count ?? 0) > limit;
}

async function hasExistingLead(clientId: string, platform: string, senderId: string): Promise<boolean> {
  const { data } = await supabase
    .from("socialbot_leads")
    .select("id")
    .eq("client_id", clientId)
    .eq("platform", platform)
    .eq("sender_id", senderId)
    .maybeSingle();
  return !!data;
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
    buildLeadInstructions(aiSettings?.topics ?? null),
    buildComplaintInstructions(),
    `Respondé EXCLUSIVAMENTE con un JSON valido (sin texto antes ni despues, sin markdown, sin \`\`\`), con esta forma exacta:`,
    `{"reply": "<tu respuesta al usuario>", "sentiment": "negativo"|"neutral"|"positivo", "lead": {"is_hot": true|false, "stage": "interesado"|"potencial"|"listo_para_comprar"|"cliente_existente"|"no_lead", "name": "<nombre si lo menciono, o null>", "contact": "<telefono/email/usuario si lo menciono, o null>", "interest": "<en pocas palabras que le interesa, o null>"}}`,
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
      return {
        reply: rawContent.length > maxChars ? rawContent.slice(0, maxChars).trim() : rawContent,
        lead: null,
        sentiment: "neutral",
      };
    }

    const reply: string | undefined = parsed?.reply?.trim();
    if (!reply) {
      await debugLog(clientId, "callGroq_no_reply_field", rawContent.slice(0, 500));
      return null;
    }

    const rawSentiment = parsed?.sentiment;
    const sentiment: "negativo" | "neutral" | "positivo" =
      rawSentiment === "negativo" || rawSentiment === "positivo" ? rawSentiment : "neutral";

    const leadRaw = parsed?.lead;
    const rawStage: string | null = leadRaw?.stage ?? null;
    const isHot = !!(leadRaw?.is_hot || (rawStage && rawStage !== "no_lead"));
    const lead: LeadDetection | null = isHot
      ? {
          is_hot: true,
          name: leadRaw?.name ?? null,
          contact: leadRaw?.contact ?? null,
          interest: leadRaw?.interest ?? null,
          stage: (rawStage && rawStage !== "no_lead" ? rawStage : "interesado") as LeadStage,
        }
      : null;

    await debugLog(clientId, "callGroq_ok", reply.slice(0, 200));

    return {
      reply: reply.length > maxChars ? reply.slice(0, maxChars).trim() : reply,
      lead,
      sentiment,
    };
  } catch (e) {
    console.error("Error llamando a Groq:", e);
    await debugLog(clientId, "callGroq_exception", String(e));
    return null;
  }
}

async function saveLead(clientId: string, platform: string, senderId: string, externalId: string | null, sourceText: string, lead: LeadDetection, postId: string | null = null, senderName: string | null = null) {
  if (!senderId) return;

  const stageTag = lead.stage && lead.stage !== "no_lead" ? `[${lead.stage}] ` : "";
  const interestText = lead.interest ? `${stageTag}${lead.interest}` : (stageTag || null);

  const resolvedName = senderName ?? lead.name ?? null;

  await supabase.from("socialbot_leads").upsert(
    {
      client_id: clientId,
      platform,
      sender_id: senderId,
      external_id: externalId,
      name: resolvedName,
      contact: lead.contact,
      interest: interestText,
      source_text: sourceText,
      post_id: postId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_id,platform,sender_id" },
  );
}

async function saveFlaggedComment(clientId: string, platform: string, externalId: string, senderId: string | undefined, text: string, reason: string | null) {
  await supabase.from("socialbot_flagged_comments").upsert(
    {
      client_id: clientId,
      platform,
      external_id: externalId,
      sender_id: senderId ?? null,
      text,
      reason,
      status: "pendiente",
    },
    { onConflict: "platform,external_id" },
  );
}

async function tryAiReply(account: any, incomingText: string): Promise<{ reply: string; source: "ia" | "ia-cache"; lead: LeadDetection | null; sentiment: "negativo" | "neutral" | "positivo" } | null> {
  const clientId = account.client_id;
  const aiSettings = account.socialbot_clients?.socialbot_ai_settings;
  const salesLink = account.socialbot_clients?.sales_link ?? null;

  const limit = aiSettings?.daily_ai_reply_limit || DEFAULT_DAILY_AI_LIMIT;

  const normalized = normalizeQuestion(incomingText);
  if (!normalized) return null;

  const cached = await getCachedReply(clientId, normalized);
  if (cached) return { reply: cached, source: "ia-cache", lead: null, sentiment: "neutral" };

  const usedToday = await getTodayUsage(clientId);
  if (usedToday >= limit) {
    await debugLog(clientId, "limite_diario_alcanzado", `usedToday=${usedToday} limit=${limit}`);
    return null;
  }

  const aiReply = await callGroq(aiSettings, salesLink, incomingText, clientId);
  if (!aiReply) return null;

  await incrementUsage(clientId);
  await saveCachedReply(clientId, normalized, aiReply.reply);

  return { reply: aiReply.reply, source: "ia", lead: aiReply.lead, sentiment: aiReply.sentiment };
}

// ---------------------------------------------------------------------------
async function handleComment(params: { platform: string; pageId: string; commentId: string; text: string; senderId?: string; senderName?: string | null; postId?: string | null }) {
  const { platform, pageId, commentId, text, senderId, senderName, postId } = params;
  if (!commentId) return;

  const account = await findSocialAccountAndClient(platform, pageId);
  if (!account) return;

  // Cliente pausado (ej. no pago este mes): no gastar cuota de IA ni
  // procesar nada para el, aunque su pagina siga recibiendo comentarios.
  // Se reactiva solo al volver active=true desde el panel de agencia.
  if (account.socialbot_clients?.active === false) return;

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
  const claimed = await claimInteraction(account.client_id, platform, "comment", commentId, senderId);
  if (!claimed) return;

  // Propuesta 11: si este sender_id viene insistiendo (mas de N interacciones
  // en la ultima hora), se corta aca -- no se autoresponde nada, solo queda
  // logueado (ya se reservo arriba con claimInteraction).
  if (await isSenderSpamming(account.client_id, senderId, aiSettings)) {
    await finishInteraction(platform, commentId, "anti-spam-limite", false);
    return;
  }

  let replyText: string | null = null;
  let matchedLabel: string | null = null;
  let leadToSave: LeadDetection | null = null;

  // 1) Primero se intenta con IA (si hay cuota y esta configurada)
  const aiResult = await tryAiReply(account, text);

  if (aiResult?.sentiment === "negativo") {
    await saveFlaggedComment(account.client_id, platform, commentId, senderId, text, aiResult.lead?.interest ?? null);
    await finishInteraction(platform, commentId, "queja-escalada", false);
    return;
  }

  if (aiResult) {
    replyText = aiResult.reply;
    matchedLabel = aiResult.source; // "ia" o "ia-cache"
    leadToSave = aiResult.lead;
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

  if (!leadToSave) {
    leadToSave = heuristicLeadDetection(text, aiSettings?.topics ?? null);
  }

  if (!leadToSave && senderId) {
    const isReturning = await hasExistingLead(account.client_id, platform, senderId);
    if (isReturning) {
      leadToSave = { is_hot: true, name: null, contact: null, interest: text.slice(0, 200), stage: "potencial" };
    }
  }

  if (leadToSave?.is_hot) {
    await saveLead(account.client_id, platform, senderId ?? "", commentId, text, leadToSave, postId ?? null, senderName ?? null);
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

  // Cliente pausado: mismo criterio que handleComment, no gastar cuota de
  // IA ni procesar nada mientras este pausado.
  if (account.socialbot_clients?.active === false) return;

  const aiSettings = account.socialbot_clients?.socialbot_ai_settings;
  const salesLink = account.socialbot_clients?.sales_link ?? null;

  // Nunca responder a un DM que en realidad mando la propia cuenta.
  if (senderId && (senderId === account.page_id || senderId === account.ig_business_id)) {
    return;
  }

  const dmId = `${pageId}-${senderId}-${Date.now()}`;

  const claimed = await claimInteraction(account.client_id, platform, "dm", dmId, senderId);
  if (!claimed) return;

  // Propuesta 11: mismo chequeo anti-spam que en handleComment.
  if (await isSenderSpamming(account.client_id, senderId, aiSettings)) {
    await finishInteraction(platform, dmId, "anti-spam-limite", false);
    return;
  }

  let replyText: string | null = null;
  let matchedLabel: string | null = null;
  let leadToSave: LeadDetection | null = null;

  const aiResult = await tryAiReply(account, text);
  if (aiResult) {
    replyText = aiResult.reply;
    matchedLabel = aiResult.source;
    leadToSave = aiResult.lead;
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

  if (!leadToSave) {
    leadToSave = heuristicLeadDetection(text, aiSettings?.topics ?? null);
  }
  if (!leadToSave && senderId) {
    const isReturning = await hasExistingLead(account.client_id, platform, senderId);
    if (isReturning) {
      leadToSave = { is_hot: true, name: null, contact: null, interest: text.slice(0, 200), stage: "potencial" };
    }
  }
  if (leadToSave?.is_hot) {
    await saveLead(account.client_id, platform, senderId, null, text, leadToSave);
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
