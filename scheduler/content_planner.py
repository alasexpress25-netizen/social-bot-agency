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
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY_CONTENT_PLAN") or os.environ.get("GEMINI_API_KEY")

if not os.environ.get("GROQ_API_KEY_CONTENT_PLAN") and not os.environ.get("OPENAI_API_KEY_CONTENT_PLAN") and not os.environ.get("CLAUDE_API_KEY_CONTENT_PLAN") and not os.environ.get("GEMINI_API_KEY_CONTENT_PLAN"):
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


def _call_gemini_json(system_prompt, user_prompt):
    r = requests.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
        headers={"Content-Type": "application/json"},
        params={"key": GEMINI_API_KEY},
        json={
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {"temperature": 0.8, "responseMimeType": "application/json"},
        },
        timeout=90,
    )
    r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()


def call_ai_json(provider, system_prompt, user_prompt):
    if provider == "openai":
        raw = _call_openai_json(system_prompt, user_prompt)
    elif provider == "claude":
        raw = _call_claude_json(system_prompt, user_prompt)
    elif provider == "gemini":
        raw = _call_gemini_json(system_prompt, user_prompt)
    else:
        # groq (default): si falla (ej. rate limit), cae a Gemini antes de
        # abortar el plan semanal (pedido 21/07/2026).
        try:
            raw = _call_groq_json(system_prompt, user_prompt)
        except Exception as e:
            if GEMINI_API_KEY:
                print(f"  ! Groq fallo ({e}), reintentando con Gemini...")
                raw = _call_gemini_json(system_prompt, user_prompt)
            else:
                raise
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
        scored.append({"caption": post["caption"], "score": score, "metrics": m, "published_at": post.get("published_at")})

    scored.sort(key=lambda x: x["score"], reverse=True)
    top_posts = scored[:3]
    bottom_posts = scored[-3:] if len(scored) > 3 else []

    # Item 1.5 de propuestas-30-07-2026.md (biblia-marketing-confianza.md,
    # pilar 3 "Testimonio de cliente real"): resenas reales positivas ya
    # capturadas por reviews_monitor.py, listas para reciclar como material
    # de contenido (nombre real + texto real, no un testimonio inventado).
    recent_reviews_raw = sb_get(
        "socialbot_reviews",
        {
            "client_id": f"eq.{client_id}",
            "rating": "gte.4",
            "order": "review_created_at.desc",
            "limit": "5",
            "select": "author_name,rating,review_text",
        },
    )
    positive_reviews = [
        r for r in (recent_reviews_raw or [])
        if r.get("review_text") and r.get("author_name")
    ]

    return {
        "recent_captions": recent_captions,
        "lead_interests": lead_interests,
        "top_posts": top_posts,
        "bottom_posts": bottom_posts,
        "posts_last_30_days": len(published),
        "best_times": best_times_from_scored(scored),
        "positive_reviews": positive_reviews,
    }


# ---------------------------------------------------------------------------
# Propuesta 13 (PROPUESTAS-AGENCIA.md, 18/07/2026): mejor horario de
# publicacion sugerido, cruzando el "score" de enganche (likes/comments/
# shares, mismo calculo que ya se usa para elegir top/bottom posts de
# arriba) contra el dia de la semana y la hora en que se publico cada post
# (socialbot_posts.published_at). Con esto el prompt de la IA no solo sabe
# QUE angulo funciono, tambien A QUE HORA conviene publicarlo -- hoy
# post_scheduler.py sigue publicando en los horarios fijos de
# socialbot_schedule_slots (esto no los cambia), pero la sugerencia queda
# en el campo "based_on" de cada idea para que la agencia vea el dato y,
# si quiere, ajuste esos horarios a mano desde el panel.
#
# Se pide un minimo de 3 posts en el mismo dia+franja horaria antes de
# sugerirlo (MIN_SAMPLES_PER_BUCKET) para no armar una "tendencia" con un
# solo dato suelto -- con pocos posts publicados todavia, best_times queda
# vacio y el prompt simplemente no menciona horarios.
# ---------------------------------------------------------------------------
_WEEKDAY_NAMES_ES = ["lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo"]
MIN_SAMPLES_PER_BUCKET = 3


def best_times_from_scored(scored, top_n=2):
    buckets = {}  # (weekday, hour) -> lista de scores
    for item in scored:
        raw = item.get("published_at")
        if not raw:
            continue
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            continue
        key = (dt.weekday(), dt.hour)  # weekday(): 0=lunes
        buckets.setdefault(key, []).append(item["score"])

    ranked = [
        (key, sum(scores) / len(scores), len(scores))
        for key, scores in buckets.items()
        if len(scores) >= MIN_SAMPLES_PER_BUCKET
    ]
    ranked.sort(key=lambda r: r[1], reverse=True)

    return [
        f"{_WEEKDAY_NAMES_ES[weekday]} alrededor de las {hour}hs (promedio de enganche mas alto, basado en {n} posts)"
        for (weekday, hour), _avg, n in ranked[:top_n]
    ]


def build_prompt(client, ai_settings, context, num_days):
    topics = ai_settings.get("topics") or ""
    tone = ai_settings.get("tone") or "cercano y profesional"
    knowledge_base = ai_settings.get("knowledge_base") or ""
    max_chars = ai_settings.get("max_chars") or 400
    # Prioridad: hashtags del cliente (cargados desde su portal) > hashtags
    # de base de la agencia. Mismo criterio que post_scheduler.py usa para
    # el caption (cliente > agencia > IA).
    default_hashtags = ai_settings.get("client_hashtags") or ai_settings.get("default_hashtags") or ""
    sales_link = client.get("sales_link") or ""

    # Item 1.5 de propuestas-30-07-2026.md: system_prompt reescrito segun
    # biblia-marketing-confianza.md. Idea central del documento: quien ve un
    # anuncio hoy no piensa "¿me sirve?" sino "¿me van a estafar?", y ninguna
    # frase de venta linda revierte eso -- solo prueba verificable lo hace.
    # Instagram/Facebook son vidriera de entretenimiento, no de venta
    # directa; el trabajo del contenido es acumular confianza para que la
    # persona de el primer paso (comentar la keyword / escribir).
    system_prompt = (
        "Sos un estratega de contenido para redes sociales de una agencia que trabaja con la filosofia del "
        "'marketing de confianza': en mercados con mucha oferta trucha, quien ve un post no piensa '¿me sirve?' "
        "sino '¿me van a estafar?', y ninguna frase de venta prolija revierte ese reflejo -- solo la prueba "
        "verificable lo hace. Instagram/Facebook son vidriera de entretenimiento, no de venta directa: el unico "
        "trabajo de cada post es acumular la confianza necesaria para que la persona de un primer paso chico "
        "(comentar la keyword para pedir el link), no para 'cerrar la venta' en el texto. "
        "Al redactar cada caption aplicá estos 5 principios: "
        "(1) especifico vence a generico -- un dato concreto y verificable pesa mas que un adjetivo de venta; "
        "(2) mostrar el proceso real, no un resultado embellecido de stock; "
        "(3) decir explicitamente que pasa si algo sale mal (garantia dicha en criollo, no en letra chica); "
        "(4) la cara humana (el dueno/a, su nombre, su voz) es la garantia mas fuerte que hay; "
        "(5) nombrar la desconfianza en vez de esquivarla ('sabemos que hay mucha oferta trucha, por eso te "
        "mostramos como trabajamos') genera alivio, no rechazo. "
        "Tu trabajo es proponer, con criterio real (no generico), que publicar esta semana para un cliente puntual, "
        "basandote en que temas le interesan a su audiencia real, que tipo de post funciono mejor antes, y rotando "
        "entre los pilares de contenido (ver mas abajo) para no repetir siempre el mismo tipo de post. "
        "Cada idea debe incluir el TEXTO FINAL del post, listo para publicar, no solo el tema."
    )

    parts = [
        f"Negocio: {client['name']}. Temas/keywords habituales: {topics or '(sin cargar)'}. Tono de marca: {tone}.",
    ]

    parts.append(
        "Pilares de contenido disponibles (rotá entre estos a lo largo de la semana, no repitas el mismo pilar en "
        "dos ideas de la misma tanda salvo que no haya otra opcion viable con los datos disponibles): "
        "1) Antes/despues real (filmado/fotografiado por el propio negocio, con lugar y fecha reconocibles); "
        "2) Proceso/detras de escena (el trabajo mientras se hace, no el resultado pulido); "
        "3) Testimonio de cliente real (nombre real, reseña real -- ver mas abajo si hay disponibles); "
        "4) Nombrar el miedo del mercado (la desconfianza tipica del rubro, contrastada con la forma de trabajar "
        "propia); 5) Ayuda comunitaria/aporte real (mostrar que el negocio ayuda a su gente, no solo que vende); "
        "6) Reversion de riesgo (la garantia dicha en criollo)."
    )
    if knowledge_base:
        parts.append(f"Informacion real del negocio (fuente de verdad, no inventes precios/datos fuera de esto): {knowledge_base}.")

    if context.get("positive_reviews"):
        reviews_txt = " || ".join(
            f"{r['author_name']} ({r['rating']}★): \"{r['review_text'][:180]}\""
            for r in context["positive_reviews"]
        )
        parts.append(
            f"Reseñas reales positivas recientes de este negocio (Google/Facebook), material listo para el pilar "
            f"'testimonio de cliente real' -- si usás alguna, citá el nombre real y una idea concreta del texto "
            f"(no inventes una reseña distinta): {reviews_txt}."
        )

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

    if context.get("best_times"):
        parts.append(
            "Segun el historial de metricas, estos son los momentos con mejor enganche para publicar: "
            + " | ".join(context["best_times"])
            + ". Si alguna de las ideas de esta semana cae naturalmente en uno de esos dias, mencionalo en \"based_on\" citando el dato "
            "(esto NO cambia el horario real de publicacion, que sigue siendo el configurado en los horarios del cliente -- es solo una senal para que la agencia lo tenga en cuenta)."
        )

    if default_hashtags:
        parts.append(
            f"Hashtags de marca fijos que la agencia ya tiene cargados (usalos como base en TODAS las ideas, sumando 2-4 propios del tema del dia): {default_hashtags}."
        )
    else:
        parts.append(
            "Todavia no hay hashtags de marca cargados -- proponé vos 5-8 hashtags relevantes en español para cada idea, "
            "mezclando genericos del rubro con algo puntual del tema del dia."
        )

    parts.append(
        f"Generá exactamente {num_days} ideas de post, una por cada dia sugerido (day_offset de 0 a {num_days - 1}, "
        f"0 = el primer dia de publicacion de esta semana, en orden creciente, sin repetir offset). "
        f"Cada caption debe tener como maximo {max_chars} caracteres SIN CONTAR los hashtags, sin markdown ni asteriscos, "
        f"con un cierre que invite EXPLICITAMENTE a comentar UNA palabra clave concreta y corta (una sola palabra, en mayusculas, ej: "
        f"\"Comentá INFO y te paso el link 💬\") para recibir el link de compra, sin poner el link directo en el texto. "
        f"IMPORTANTE: los hashtags van DENTRO del mismo campo \"caption\" (no en un campo aparte), como el ultimo renglon del texto, "
        f"separados del resto por un salto de linea en blanco. Ejemplo de como debe terminar el campo \"caption\" completo: "
        f"\"...Comentá INFO y te paso el link 💬\\n\\n#hashtag1 #hashtag2 #hashtag3\". Esto es obligatorio en TODAS las ideas, sin excepcion. "
        f"Esa misma palabra clave (en minuscula, sin tildes ni signos) va tambien en el campo \"keyword\" del JSON, EXACTAMENTE la que aparece en el caption. "
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
        '{"ideas": [{"day_offset": 0, "angle": "<pilar usado (uno de los 6 de arriba, en pocas palabras) + angulo concreto>", '
        '"based_on": "<por que se sugiere esto, en una frase corta y concreta, citando el dato real: lead, metrica o vacio de contenido>", '
        '"caption": "<texto final del post, terminando con los hashtags en el ultimo renglon>", '
        '"keyword": "<la palabra clave del cierre, en minuscula, una sola palabra>", '
        '"reply_template": "<respuesta automatica para esa palabra clave, con {{sales_link}} donde va el link>", '
        '"hashtags": "<opcional -- dejalo vacio si ya pusiste los hashtags al final del caption, que es lo esperado>"}]}'
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


# Hashtags como ultimo renglon del propio "caption" (ver instruccion en
# build_prompt): mas confiable que un campo JSON aparte porque es parte del
# contenido principal que el modelo SI redacta siempre, en vez de un campo
# secundario que se salta con facilidad (ver charla 15/07/2026 -- con Groq
# quedaba vacio en las 7 ideas de la semana). Reconoce el(los) ultimo(s)
# renglon(es) compuestos SOLO por tokens que empiezan con #, y los separa
# del texto del post.
_HASHTAG_LINE_RE = re.compile(r"(?:\n[ \t]*)+((?:#\S+)(?:\s+#\S+)*)\s*$")


def split_caption_and_hashtags(raw_caption):
    raw_caption = (raw_caption or "").strip()
    match = _HASHTAG_LINE_RE.search(raw_caption)
    if match:
        hashtags = match.group(1).strip()
        caption = raw_caption[: match.start()].strip()
        if caption:
            return caption, hashtags
    return raw_caption, ""


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
        clean_caption, extracted_hashtags = split_caption_and_hashtags(idea["caption"])
        hashtags_val = extracted_hashtags or (idea.get("hashtags") or "").strip()
        if not hashtags_val:
            base_hashtags = ai_settings.get("client_hashtags") or ai_settings.get("default_hashtags") or ""
            hashtags_val = fallback_hashtags(base_hashtags, ai_settings.get("topics") or "")
        rows.append(
            {
                "client_id": client_id,
                "week_start": week_start.isoformat(),
                "target_date": target_date.isoformat(),
                "angle": (idea.get("angle") or "")[:200] or None,
                "based_on": (idea.get("based_on") or "")[:400] or None,
                "caption": clean_caption,
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
