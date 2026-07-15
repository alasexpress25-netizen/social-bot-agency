"""
content_planner.py
-------------------
FASE 6: una vez por semana (cron nuevo, ver
.github/workflows/content_planner.yml), para cada cliente activo con al
menos un horario de publicacion configurado:

  1. Junta el contexto real de esa semana:
     - tono/temas/base de conocimiento (socialbot_ai_settings, igual que
       post_scheduler.py usa hoy para generar un caption suelto)
     - los ultimos ~15 captions publicados (para no repetir angulo)
     - el interes de los ultimos leads (que le pregunta la gente de verdad)
     - la performance de los ultimos 30 dias de posts publicados
       (socialbot_post_metrics: likes, comentarios, shares, reach) --
       separa los 3 que mejor engancharon de los 3 que peor, con su texto,
       para que la IA entienda que angulo funciona con esa audiencia
     - cuantos dias por semana publica ese cliente (segun sus
       schedule_slots activos) -- eso define cuantas ideas hacen falta
  2. Le pide a la IA (mismo provider que ya tiene configurado el cliente:
     groq/openai/claude) un lote de posts YA REDACTADOS para los proximos
     dias, en JSON.
  3. Los guarda en socialbot_content_plan_items con status='proposed'.

La agencia despues revisa, edita y aprueba/rechaza cada uno desde el panel
(frontend/index.html, seccion "Plan semanal de contenido"). Un item
aprobado lo usa post_scheduler.py automaticamente el dia que corresponda
(ver get_approved_plan_item_for_today() en ese archivo) -- no hace falta
ninguna accion manual extra despues de aprobar.

No pisa nada si ya existe un plan para la semana: antes de generar, se
fija si ya hay items 'proposed' o 'approved' con ese week_start para el
cliente, y si los hay, se salta (evita duplicar el trabajo si el cron
corre dos veces o alguien lo dispara a mano de mas). Para forzar un plan
nuevo de una semana ya generada, hay que borrar/rechazar los items viejos
primero.
"""

import os
import json
import re
import socket
import unicodedata
import requests
from datetime import datetime, timezone, timedelta

# Mismo parche de IPv4-only que post_scheduler.py -- ver ahi el detalle del
# por que hace falta en los runners de GitHub Actions.
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_only_getaddrinfo

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

# ---------------------------------------------------------------------------
# Keys de IA SEPARADAS de las que usa meta-webhook (comentarios/DMs) y
# post_scheduler.py (caption al momento de publicar). Pedido por la agencia
# el 15/07/2026: si todo comparte la misma key de Groq, un cliente con
# mucho movimiento de comentarios puede agotar la cuota gratuita antes de
# que corra este cron semanal, o al reves. Se usan secrets *_CONTENT_PLAN
# nuevos y separados; si todavia no se cargaron en GitHub Actions, cae de
# vuelta a la key compartida (con aviso) para no romper la primera corrida.
# ---------------------------------------------------------------------------
GROQ_API_KEY = os.environ.get("GROQ_API_KEY_CONTENT_PLAN") or os.environ.get("GROQ_API_KEY")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY_CONTENT_PLAN") or os.environ.get("OPENAI_API_KEY")
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY_CONTENT_PLAN") or os.environ.get("CLAUDE_API_KEY")

if not os.environ.get("GROQ_API_KEY_CONTENT_PLAN") and not os.environ.get("OPENAI_API_KEY_CONTENT_PLAN") and not os.environ.get("CLAUDE_API_KEY_CONTENT_PLAN"):
    print("AVISO: no hay ninguna *_API_KEY_CONTENT_PLAN configurada como secret separado -- este cron va a compartir cuota con el webhook de comentarios y post_scheduler.py. Ver README (pedido 15/07/2026) para crear una key de Groq nueva y separarla.")

SUPABASE_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}

MAX_IDEAS_PER_WEEK = 7  # tope duro aunque el cliente publique "todos los dias"


def sb_get(table, params):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SUPABASE_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def sb_insert(table, rows):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**SUPABASE_HEADERS, "Prefer": "return=representation"},
        json=rows,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# Llamadas a IA (mismos providers/criterio que post_scheduler.py; se
# duplica aca en vez de importar porque cada script corre como job
# independiente de GitHub Actions, sin empaquetado compartido entre ambos).
# ---------------------------------------------------------------------------
def _call_groq_json(system_prompt, user_prompt):
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": "llama-3.3-70b-versatile",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.8,
            "response_format": {"type": "json_object"},
        },
        timeout=90,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _call_openai_json(system_prompt, user_prompt):
    r = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.8,
            "response_format": {"type": "json_object"},
        },
        timeout=90,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def _call_claude_json(system_prompt, user_prompt):
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        json={
            "model": "claude-sonnet-4-6",
            "max_tokens": 2000,
            "system": system_prompt + " Respondé EXCLUSIVAMENTE con el JSON pedido, sin texto antes ni después, sin markdown, sin ```.",
            "messages": [{"role": "user", "content": user_prompt}],
        },
        timeout=90,
    )
    r.raise_for_status()
    return r.json()["content"][0]["text"].strip()


def call_ai_json(provider, system_prompt, user_prompt):
    if provider == "openai":
        raw = _call_openai_json(system_prompt, user_prompt)
    elif provider == "claude":
        raw = _call_claude_json(system_prompt, user_prompt)
    else:
        raw = _call_groq_json(system_prompt, user_prompt)
    return json.loads(raw)


# ---------------------------------------------------------------------------
# Contexto por cliente
# ---------------------------------------------------------------------------
def get_target_days(client_id):
    """
    Dias de la semana (1=Lunes..7=Domingo) en los que este cliente tiene al
    menos un horario activo. Si tiene algun slot con day_of_week=NULL
    ("todos los dias"), se consideran los 7. Tope de MAX_IDEAS_PER_WEEK
    para no generar mas ideas de las razonables aunque publique varias
    veces por dia.
    """
    slots = sb_get("socialbot_schedule_slots", {"client_id": f"eq.{client_id}", "active": "eq.true"})
    if not slots:
        return []
    if any(s.get("day_of_week") is None for s in slots):
        days = list(range(1, 8))
    else:
        days = sorted({s["day_of_week"] for s in slots})
    return days[:MAX_IDEAS_PER_WEEK]


def build_context(client, ai_settings):
    client_id = client["id"]

    recent_posts = sb_get(
        "socialbot_posts",
        {"client_id": f"eq.{client_id}", "order": "created_at.desc", "limit": "15", "select": "caption"},
    )
    recent_captions = [p["caption"] for p in recent_posts if p.get("caption")]

    recent_leads = sb_get(
        "socialbot_leads",
        {"client_id": f"eq.{client_id}", "order": "created_at.desc", "limit": "20", "select": "interest,status"},
    )
    lead_interests = [l["interest"] for l in recent_leads if l.get("interest")]

    since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    published = sb_get(
        "socialbot_posts",
        {
            "client_id": f"eq.{client_id}",
            "status": "eq.published",
            "published_at": f"gte.{since}",
            "select": "id,caption,published_at",
        },
    )
    scored = []
    for post in published:
        metrics = sb_get("socialbot_post_metrics", {"post_id": f"eq.{post['id']}", "limit": "1"})
        if not metrics:
            continue
        m = metrics[0]
        score = (m.get("likes") or 0) + (m.get("comments") or 0) * 2 + (m.get("shares") or 0) * 3
        scored.append({"caption": post["caption"], "score": score, "metrics": m})

    scored.sort(key=lambda x: x["score"], reverse=True)
    top_posts = scored[:3]
    bottom_posts = scored[-3:] if len(scored) > 3 else []

    return {
        "recent_captions": recent_captions,
        "lead_interests": lead_interests,
        "top_posts": top_posts,
        "bottom_posts": bottom_posts,
        "posts_last_30_days": len(published),
    }


def build_prompt(client, ai_settings, context, num_days):
    topics = ai_settings.get("topics") or ""
    tone = ai_settings.get("tone") or "cercano y profesional"
    knowledge_base = ai_settings.get("knowledge_base") or ""
    max_chars = ai_settings.get("max_chars") or 400
    default_hashtags = ai_settings.get("default_hashtags") or ""
    sales_link = client.get("sales_link") or ""

    system_prompt = (
        "Sos un estratega de contenido para redes sociales de una agencia. "
        "Tu trabajo es proponer, con criterio real (no generico), que publicar esta semana para un cliente puntual, "
        "basandote en que temas le interesan a su audiencia real y que tipo de post funciono mejor antes. "
        "Cada idea debe incluir el TEXTO FINAL del post, listo para publicar, no solo el tema."
    )

    parts = [
        f"Negocio: {client['name']}. Temas/keywords habituales: {topics or '(sin cargar)'}. Tono de marca: {tone}.",
    ]
    if knowledge_base:
        parts.append(f"Informacion real del negocio (fuente de verdad, no inventes precios/datos fuera de esto): {knowledge_base}.")

    if context["lead_interests"]:
        parts.append(
            "Estas son cosas que preguntaron/mostraron interes contactos reales ultimamente (usalas como pista de que le importa a la audiencia, sin repetir textual): "
            + " | ".join(context["lead_interests"][:15])
        )
    else:
        parts.append("Todavia no hay contactos interesados registrados para este cliente, no asumas ningun interes puntual mas alla de los temas generales.")

    if context["top_posts"]:
        top_txt = " || ".join(
            f"\"{p['caption'][:180]}\" (likes:{p['metrics'].get('likes',0)} comments:{p['metrics'].get('comments',0)} shares:{p['metrics'].get('shares',0)})"
            for p in context["top_posts"]
        )
        parts.append(f"Los posts que MEJOR engancharon en los ultimos 30 dias fueron: {top_txt}. Considera angulos similares (mismo tono/formato/gancho), sin copiar el texto.")

    if context["bottom_posts"]:
        bottom_txt = " || ".join(f"\"{p['caption'][:180]}\"" for p in context["bottom_posts"])
        parts.append(f"Los que PEOR engancharon fueron: {bottom_txt}. Evita repetir ese angulo tal cual.")

    if context["recent_captions"]:
        recent_txt = " || ".join(c[:120] for c in context["recent_captions"][:15])
        parts.append(f"Ya se publicaron estos posts recientemente (NO los repitas ni uses el mismo gancho): {recent_txt}")

    if context["posts_last_30_days"] == 0:
        parts.append("No hay posts publicados en los ultimos 30 dias con metricas disponibles todavia -- proponé variedad de angulos sin depender de datos de performance.")

    if default_hashtags:
        parts.append(
            f"Hashtags de marca fijos que la agencia ya tiene cargados (usalos como base en TODAS las ideas, sumando 2-4 propios del tema del dia): {default_hashtags}. "
            "El campo \"hashtags\" de CADA idea es OBLIGATORIO, nunca lo dejes vacio: incluí ahí los de marca mas los 2-4 del tema del dia."
        )
    else:
        parts.append(
            "Todavia no hay hashtags de marca cargados -- el campo \"hashtags\" de CADA idea es OBLIGATORIO, nunca lo dejes vacio: "
            "proponé vos 5-8 hashtags relevantes en español para esa idea puntual, mezclando genericos del rubro con algo puntual del tema del dia "
            "(ej: \"#marketingdigital #redessociales #pymes\")."
        )

    parts.append(
        f"Generá exactamente {num_days} ideas de post, una por cada dia sugerido (day_offset de 0 a {num_days - 1}, "
        f"0 = el primer dia de publicacion de esta semana, en orden creciente, sin repetir offset). "
        f"Cada caption debe tener como maximo {max_chars} caracteres, sin markdown ni asteriscos, sin hashtags adentro (van aparte), "
        f"con un cierre que invite EXPLICITAMENTE a comentar UNA palabra clave concreta y corta (una sola palabra, en mayusculas, ej: "
        f"\"Comentá INFO y te paso el link 💬\") para recibir el link de compra, sin poner el link directo en el texto. "
        f"Esa misma palabra (en minuscula, sin tildes ni signos) va tambien en el campo \"keyword\" del JSON, EXACTAMENTE la que aparece en el caption. "
        f"Variá la palabra clave entre ideas de la semana si tiene sentido (no hace falta que sea siempre la misma). "
        f"Variá el angulo entre ideas (no repitas el mismo gancho dos veces en la misma semana)."
    )

    parts.append(
        "Para cada idea generá tambien \"reply_template\": el mensaje automatico corto que el bot le va a responder a quien comente o escriba esa palabra clave "
        "(tono cercano, confirma el interes y avisa que le llega el link), usando literalmente el texto {{sales_link}} donde deba ir el link "
        f"(no inventes una URL). {(f'El link de venta de este cliente es: {sales_link}.' if sales_link else 'Este cliente todavia no tiene un link de venta cargado.')}"
    )

    parts.append(
        'Respondé EXCLUSIVAMENTE con un JSON valido (sin texto antes ni despues, sin markdown, sin ```), con esta forma exacta: '
        '{"ideas": [{"day_offset": 0, "angle": "<angulo/pilar en pocas palabras>", '
        '"based_on": "<por que se sugiere esto, en una frase corta y concreta, citando el dato real: lead, metrica o vacio de contenido>", '
        '"caption": "<texto final del post, con el cierre que invita a comentar la palabra clave>", '
        '"keyword": "<la palabra clave del cierre, en minuscula, una sola palabra>", '
        '"reply_template": "<respuesta automatica para esa palabra clave, con {{sales_link}} donde va el link>", '
        '"hashtags": "<OBLIGATORIO, nunca vacio: hashtags de este post, separados por espacio, cada uno con #, minimo 3>"}]}'
    )

    return system_prompt, " ".join(parts)


# ---------------------------------------------------------------------------
# Respaldo si la IA ignora el campo "hashtags" (pasa mas seguido de lo que
# deberia con modelos sin JSON schema estricto, como Groq/llama). En vez de
# dejarlo vacio -- que obliga a la agencia a cargarlo a mano en cada idea --
# armamos algo razonable: los hashtags de marca ya cargados, o si no hay,
# derivamos 2-3 de los "topics" del cliente. Nunca se llama si la IA SI
# devolvio hashtags (ver generate_plan_for_client).
# ---------------------------------------------------------------------------
def _slugify_tag(word):
    word = unicodedata.normalize("NFKD", word).encode("ascii", "ignore").decode("ascii")
    word = re.sub(r"[^a-zA-Z0-9]", "", word)
    return f"#{word}" if word else ""


def fallback_hashtags(default_hashtags, topics):
    tags = [t for t in (default_hashtags or "").split() if t.startswith("#")]
    if not tags and topics:
        for chunk in re.split(r"[,\n]", topics)[:5]:
            first_word = chunk.strip().split(" ")[0] if chunk.strip() else ""
            tag = _slugify_tag(first_word)
            if tag and tag not in tags:
                tags.append(tag)
    return " ".join(tags[:8])


def generate_plan_for_client(client):
    client_id = client["id"]

    days = get_target_days(client_id)
    if not days:
        print(f"Cliente {client['name']}: sin horarios activos configurados, se salta (no hay donde publicar el plan).")
        return

    today = datetime.now(timezone.utc).date()
    week_start = today - timedelta(days=today.isoweekday() - 1)  # lunes de esta semana ISO
    existing = sb_get(
        "socialbot_content_plan_items",
        {
            "client_id": f"eq.{client_id}",
            "week_start": f"eq.{week_start.isoformat()}",
            "status": "in.(proposed,approved,used)",
            "limit": "1",
        },
    )
    if existing:
        print(f"Cliente {client['name']}: ya existe un plan para la semana del {week_start.isoformat()}, se salta.")
        return

    ai_rows = sb_get("socialbot_ai_settings", {"client_id": f"eq.{client_id}"})
    ai_settings = ai_rows[0] if ai_rows else {"content_plan_provider": "groq"}
    # content_plan_provider es INDEPENDIENTE de 'provider' (que usan el
    # webhook de comentarios y el caption al momento de publicar) -- ver
    # migracion content_plan_provider, pedido 15/07/2026.
    provider = ai_settings.get("content_plan_provider") or "groq"

    context = build_context(client, ai_settings)
    system_prompt, user_prompt = build_prompt(client, ai_settings, context, len(days))

    try:
        result = call_ai_json(provider, system_prompt, user_prompt)
    except Exception as e:
        print(f"Cliente {client['name']}: fallo la llamada a la IA ({provider}): {e}")
        return

    ideas = result.get("ideas") or []
    if not ideas:
        print(f"Cliente {client['name']}: la IA no devolvio ideas, se salta.")
        return

    rows = []
    for idea in ideas:
        try:
            offset = int(idea["day_offset"])
        except (KeyError, ValueError, TypeError):
            continue
        if offset < 0 or offset >= len(days) or not idea.get("caption"):
            continue
        target_date = week_start + timedelta(days=days[offset] - 1)
        # Normalizamos la keyword (minuscula, sin espacios de mas) para que
        # despues, al aprobar el item, coincida exactamente con la palabra
        # que el caption invita a comentar y con lo que matchea meta-webhook.
        keyword = (idea.get("keyword") or "").strip().lower() or None
        hashtags_val = (idea.get("hashtags") or "").strip()
        if not hashtags_val:
            hashtags_val = fallback_hashtags(ai_settings.get("default_hashtags") or "", ai_settings.get("topics") or "")
        rows.append(
            {
                "client_id": client_id,
                "week_start": week_start.isoformat(),
                "target_date": target_date.isoformat(),
                "angle": (idea.get("angle") or "")[:200] or None,
                "based_on": (idea.get("based_on") or "")[:400] or None,
                "caption": idea["caption"].strip(),
                "keyword": keyword,
                "reply_template": (idea.get("reply_template") or "").strip() or None,
                "hashtags": hashtags_val or None,
                "status": "proposed",
            }
        )

    if not rows:
        print(f"Cliente {client['name']}: la IA respondio pero ningun item era usable, se salta.")
        return

    sb_insert("socialbot_content_plan_items", rows)
    print(f"Cliente {client['name']}: plan generado con {len(rows)} idea(s) para la semana del {week_start.isoformat()}.")


def run():
    clients = sb_get("socialbot_clients", {"active": "eq.true"})
    print(f"Generando plan semanal para {len(clients)} cliente(s) activo(s)...")
    for client in clients:
        try:
            generate_plan_for_client(client)
        except Exception as e:
            print(f"ERROR generando plan para cliente {client.get('id')}: {e}")


if __name__ == "__main__":
    run()
