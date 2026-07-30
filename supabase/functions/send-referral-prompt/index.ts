// supabase/functions/send-referral-prompt/index.ts
//
// Punto 8 de propuestas-30-07-2026.md (Fase 7.6 del roadmap propio):
// manda el mensaje de referido/reseña real al lead, pero SOLO despues de
// que la agencia aprobo la sugerencia desde el panel (status 'proposed'
// -> 'approved', UPDATE directo sobre socialbot_referral_suggestions).
// Disparado por el trigger trg_send_referral_suggestion
// (0030_referral_suggestions.sql) via pg_net.
//
// El mensaje se manda como DM (Send API / me/messages), no como reply de
// comentario -- es un pedido personal (reseña/referido), no una
// respuesta publica a algo que el lead escribio. Mismo endpoint que ya
// usa handleDm() en meta-webhook/index.ts.
//
// verify_jwt=false, mismo motivo que el resto de las funciones invocadas
// por pg_net: quien llama es el propio Postgres, no un usuario autenticado.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GRAPH_API_VERSION = "v21.0";

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

  const { data: suggestion, error } = await supabase
    .from("socialbot_referral_suggestions")
    .select("id, client_id, platform, sender_id, message, status")
    .eq("id", suggestionId)
    .maybeSingle();

  if (error || !suggestion) {
    console.error("No se encontro la sugerencia de referido", suggestionId, error);
    return new Response("sugerencia no encontrada", { status: 200 });
  }

  if (suggestion.status !== "approved") {
    return new Response(`sugerencia en estado '${suggestion.status}', no se envia`, { status: 200 });
  }

  const { data: account } = await supabase
    .from("socialbot_social_accounts")
    .select("page_id, page_access_token")
    .eq("client_id", suggestion.client_id)
    .eq("platform", suggestion.platform)
    .maybeSingle();

  if (!account?.page_access_token) {
    await supabase
      .from("socialbot_referral_suggestions")
      .update({ status: "failed", send_error: "sin cuenta social conectada para ese cliente/plataforma", updated_at: new Date().toISOString() })
      .eq("id", suggestionId);
    return new Response("sin cuenta social, marcado como failed", { status: 200 });
  }

  try {
    const resp = await fetch(
      `https://graph.facebook.com/${GRAPH_API_VERSION}/me/messages?access_token=${account.page_access_token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: suggestion.sender_id },
          message: { text: suggestion.message },
        }),
      },
    );

    if (resp.ok) {
      await supabase
        .from("socialbot_referral_suggestions")
        .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq("id", suggestionId);
      return new Response("ok, mensaje enviado", { status: 200 });
    } else {
      const errText = await resp.text();
      console.error("Error enviando mensaje de referido:", errText);
      await supabase
        .from("socialbot_referral_suggestions")
        .update({ status: "failed", send_error: errText.slice(0, 500), updated_at: new Date().toISOString() })
        .eq("id", suggestionId);
      return new Response("error enviando, marcado como failed", { status: 200 });
    }
  } catch (e) {
    console.error("Excepcion enviando mensaje de referido:", e);
    await supabase
      .from("socialbot_referral_suggestions")
      .update({ status: "failed", send_error: String(e).slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", suggestionId);
    return new Response("excepcion, marcado como failed", { status: 200 });
  }
});
