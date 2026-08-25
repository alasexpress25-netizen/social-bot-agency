"""
reviews_monitor.py
-------------------
Item 8 de PROPUESTAS-AGENCIA.md: reseñas de Google/Facebook monitoreadas.

Corre por cron (ver .github/workflows/reviews_monitor.yml) cada pocas
horas. Para cada cliente activo:

  1. Si tiene una cuenta de Facebook conectada (socialbot_social_accounts,
     platform='facebook'), busca sus "recommendations" (ratings) nuevas
     via Graph API, usando el mismo page_access_token que ya usa
     meta-webhook para todo lo demás.
  2. Si tiene google_place_id cargado (socialbot_clients.google_place_id,
     0020_reviews.sql), busca sus reseñas de Google via Places API
     (Place Details, campo "reviews" -- devuelve como mucho las últimas 5
     reseñas más relevantes; es la limitación de la API pública, no de
     este script).
  3. Guarda las que sean nuevas en socialbot_reviews (unique por
     platform+external_id evita duplicar en corridas siguientes) con una
     respuesta sugerida generada por IA (mismo provider ya configurado
     para el cliente en socialbot_ai_settings).

La agencia después la revisa desde el panel (frontend/index.html, sección
"Reseñas"): copia la sugerencia, la publica a mano en Facebook/Google
Business (ninguna de las dos APIs permite postear la respuesta pública de
una reseña vía integraciones simples de terceros sin permisos especiales
adicionales), y marca el estado.

Secrets necesarios (GitHub Actions, junto a los que ya usan los otros
scheduler/*.py):
  - SUPABASE_URL, SUPABASE_SERVICE_KEY (ya existentes)
  - GOOGLE_PLACES_API_KEY (nuevo, solo si se quiere el monitoreo de Google;
    si no está seteado, el script simplemente se salta esa parte)
  - GROQ_API_KEY / OPENAI_API_KEY / CLAUDE_API_KEY (ya existentes, para la
    sugerencia de respuesta)
"""

import os
import socket
import requests
from datetime import datetime, timezone

# Mismo parche de IPv4-only que el resto de scheduler/*.py (los runners de
# GitHub Actions a veces resuelven IPv6 primero y Supabase/Meta no
# responden bien por esa vía).
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_only_getaddrinfo

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
GOOGLE_PLACES_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY")

GROQ_API_KEY = os.environ.get("GROQ_API_KEY")
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")

SUPABASE_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}

GRAPH_VERSION = "v19.0"


def sb_get(table, params):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SUPABASE_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def sb_insert(table, row):
    """Insert tolerante a duplicados: si ya existe (unique platform+external_id),
    Supabase devuelve 409 y lo tratamos como éxito silencioso (ya estaba guardada)."""
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**SUPABASE_HEADERS, "Prefer": "return=representation,resolution=ignore-duplicates"},
        json=row,
        timeout=30,
    )
    if r.status_code >= 400 and r.status_code != 409:
        print(f"  ! error guardando reseña: {r.status_code} {r.text[:300]}")
    return r.ok


# ---------------------------------------------------------------------------
# IA para la respuesta sugerida (mismo criterio que content_planner.py:
# duplicado en cada script porque corren como jobs independientes)
# ---------------------------------------------------------------------------
def _call_groq(system_prompt, user_prompt):
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
        json={
            # llama-3.3-70b-versatile fue dado de baja por Groq (deprecado
            # 17/06/2026, decomisionado agosto 2026). Reemplazado por el
            # mismo modelo que ya usa post_scheduler.py (24/08/2026).
            "model": "openai/gpt-oss-120b",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.6,
        },
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def _call_openai(system_prompt, user_prompt):
    r = requests.post(
        "https://api.openai.com/v1/chat/completions",
        headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.6,
        },
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()


def _call_claude(system_prompt, user_prompt):
    r = requests.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": CLAUDE_API_KEY,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        },
        json={
            "model": "claude-sonnet-4-6",
            "max_tokens": 400,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_prompt}],
        },
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["content"][0]["text"].strip()


def _call_gemini(system_prompt, user_prompt):
    # Se usa el alias "gemini-flash-latest" (no una version fija como
    # "gemini-2.5-flash") porque Google jubila los modelos Gemini seguido
    # -- el mismo problema que tuvimos con Groq/Llama 3.3 (24/08/2026). El
    # alias apunta siempre al ultimo Flash estable sin tocar el codigo.
    r = requests.post(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
        headers={"Content-Type": "application/json"},
        params={"key": GEMINI_API_KEY},
        json={
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [{"role": "user", "parts": [{"text": user_prompt}]}],
            "generationConfig": {"temperature": 0.6},
        },
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()


def suggest_reply(provider, client_name, tone, reply_language, rating_or_reco, review_text):
    lang_note = {
        "pt-BR": "Respondé en portugués de Brasil.",
        "es": "Respondé en español.",
    }.get(reply_language, "Respondé en el mismo idioma en que está escrita la reseña.")

    is_negative = rating_or_reco in ("negative", 1, 2)
    system_prompt = (
        f"Sos el/la encargado/a de atención al cliente de '{client_name}'. "
        f"Tono: {tone or 'cercano y profesional'}. {lang_note} "
        "Escribí SOLO el texto de la respuesta pública a esta reseña, sin comillas, "
        "sin firma, sin explicaciones, 2-4 oraciones como mucho. "
        + (
            "La reseña es negativa: reconocé el problema sin ser defensivo, pedí disculpas "
            "si corresponde, y ofrecé seguir la conversación por privado (DM o WhatsApp)."
            if is_negative
            else "La reseña es positiva: agradecé con calidez, mencioná algo concreto si la reseña "
            "lo permite, sin sonar genérico ni repetitivo."
        )
    )
    user_prompt = f"Reseña del cliente: {review_text or '(sin texto, solo calificación)'}"

    # Prueba cada provider configurado en orden hasta que uno responda.
    # Antes se quedaba con el primero que tuviera key aunque fallara (ej.
    # Groq rate-limiteado); ahora si Groq falla, sigue con Gemini/OpenAI/
    # Claude en vez de perder la sugerencia (pedido 21/07/2026).
    providers = [
        ("Groq", GROQ_API_KEY, _call_groq),
        ("Gemini", GEMINI_API_KEY, _call_gemini),
        ("OpenAI", OPENAI_API_KEY, _call_openai),
        ("Claude", CLAUDE_API_KEY, _call_claude),
    ]
    for name, key, fn in providers:
        if not key:
            continue
        try:
            return fn(system_prompt, user_prompt)
        except Exception as e:
            print(f"  ! {name} fallo generando sugerencia de respuesta: {e}")

    # Fallback sin IA (ningún provider configurado, o la llamada falló):
    # plantilla fija en vez de dejar la reseña sin sugerencia.
    if is_negative:
        return "Lamentamos mucho tu experiencia. Nos encantaría entender qué pasó y solucionarlo — ¿podés escribirnos por privado?"
    return "¡Muchas gracias por tu comentario! Nos alegra mucho que hayas tenido una buena experiencia."


# ---------------------------------------------------------------------------
# Facebook: recommendations (ratings) de la página
# ---------------------------------------------------------------------------
def fetch_facebook_reviews(account):
    page_id = account.get("page_id")
    token = account.get("page_access_token")
    if not page_id or not token:
        return []
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_VERSION}/{page_id}/ratings",
            params={
                "access_token": token,
                "fields": "reviewer,rating,recommendation_type,review_text,created_time,open_graph_story",
                "limit": 25,
            },
            timeout=30,
        )
        r.raise_for_status()
        return r.json().get("data", [])
    except Exception as e:
        print(f"  ! error consultando ratings de Facebook para page {page_id}: {e}")
        return []


# ---------------------------------------------------------------------------
# Google: reseñas via Places API (Place Details)
# ---------------------------------------------------------------------------
def fetch_google_reviews(place_id):
    if not GOOGLE_PLACES_API_KEY or not place_id:
        return []
    try:
        r = requests.get(
            "https://maps.googleapis.com/maps/api/place/details/json",
            params={
                "place_id": place_id,
                "fields": "review",
                "key": GOOGLE_PLACES_API_KEY,
                "reviews_no_translations": "true",
            },
            timeout=30,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("status") != "OK":
            print(f"  ! Google Places devolvió status {data.get('status')} para place_id {place_id}")
            return []
        return data.get("result", {}).get("reviews", [])
    except Exception as e:
        print(f"  ! error consultando reseñas de Google para place_id {place_id}: {e}")
        return []


def process_client(client, ai_settings):
    client_id = client["id"]
    tone = ai_settings.get("tone") if ai_settings else None
    reply_language = ai_settings.get("reply_language") if ai_settings else None
    saved = 0

    # --- Facebook ---
    accounts = sb_get(
        "socialbot_social_accounts",
        {"client_id": f"eq.{client_id}", "platform": "eq.facebook", "select": "page_id,page_access_token"},
    )
    for account in accounts:
        for rev in fetch_facebook_reviews(account):
            external_id = rev.get("created_time", "") + "-" + (rev.get("reviewer", {}) or {}).get("id", "anon")
            rating = rev.get("rating")
            reco = rev.get("recommendation_type")
            text = rev.get("review_text")
            reply = suggest_reply(None, client["name"], tone, reply_language, reco or rating, text)
            ok = sb_insert(
                "socialbot_reviews",
                {
                    "client_id": client_id,
                    "platform": "facebook",
                    "external_id": external_id,
                    "author_name": (rev.get("reviewer", {}) or {}).get("name"),
                    "rating": rating,
                    "recommendation_type": reco,
                    "review_text": text,
                    "suggested_reply": reply,
                    "review_created_at": rev.get("created_time"),
                },
            )
            if ok:
                saved += 1

    # --- Google ---
    if client.get("google_place_id"):
        for rev in fetch_google_reviews(client["google_place_id"]):
            external_id = f"{rev.get('time')}-{rev.get('author_name', 'anon')}"
            rating = rev.get("rating")
            text = rev.get("text")
            reply = suggest_reply(None, client["name"], tone, reply_language, rating, text)
            review_created_at = None
            if rev.get("time"):
                review_created_at = datetime.fromtimestamp(rev["time"], tz=timezone.utc).isoformat()
            ok = sb_insert(
                "socialbot_reviews",
                {
                    "client_id": client_id,
                    "platform": "google",
                    "external_id": external_id,
                    "author_name": rev.get("author_name"),
                    "rating": rating,
                    "review_text": text,
                    "suggested_reply": reply,
                    "review_created_at": review_created_at,
                },
            )
            if ok:
                saved += 1

    return saved


def main():
    clients = sb_get("socialbot_clients", {"active": "eq.true", "select": "id,name,google_place_id"})
    print(f"Chequeando reseñas de {len(clients)} cliente(s) activo(s)...")
    total = 0
    for client in clients:
        ai_rows = sb_get("socialbot_ai_settings", {"client_id": f"eq.{client['id']}"})
        ai_settings = ai_rows[0] if ai_rows else {}
        saved = process_client(client, ai_settings)
        if saved:
            print(f"  - {client['name']}: {saved} reseña(s) nueva(s)")
        total += saved
    print(f"Listo. {total} reseña(s) nueva(s) en total.")


if __name__ == "__main__":
    main()
