"""
post_scheduler.py
------------------
Se ejecuta 5 veces al dia (via GitHub Actions cron) y para cada cliente activo
que tenga un horario (schedule_slot) que coincida con la hora actual:

  1. Genera un texto nuevo con IA (OpenAI o Claude, segun ai_settings.provider)
  2. Elige una imagen/video de la biblioteca del cliente (media_assets)
  3. Publica en Facebook y/o Instagram via Meta Graph API
  4. Guarda el resultado en la tabla `posts` de Supabase

No requiere servidor: corre como un job de GitHub Actions y termina.
Todas las credenciales sensibles viven en Supabase (por cliente) o en
GitHub Secrets (claves generales: Supabase service key, OpenAI/Claude key).
"""

import os
import sys
import time
import random
import requests
from datetime import datetime, timezone

# ---------------------------------------------------------------------------
# Config general (viene de GitHub Secrets -> variables de entorno)
# ---------------------------------------------------------------------------
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]  # service_role key (NUNCA la anon key acá)
GRAPH_API_VERSION = os.environ.get("GRAPH_API_VERSION", "v21.0")

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
CLAUDE_API_KEY = os.environ.get("CLAUDE_API_KEY")
GROQ_API_KEY = os.environ.get("GROQ_API_KEY")

SUPABASE_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}


# ---------------------------------------------------------------------------
# Helpers Supabase (REST directo, sin SDK, para no agregar dependencias)
# ---------------------------------------------------------------------------
def sb_get(table, params):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SUPABASE_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def sb_insert(table, row):
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**SUPABASE_HEADERS, "Prefer": "return=representation"},
        json=row,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


def sb_update(table, match_params, patch):
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=SUPABASE_HEADERS,
        params=match_params,
        json=patch,
        timeout=30,
    )
    r.raise_for_status()


# ---------------------------------------------------------------------------
# Generacion de texto con IA
# ---------------------------------------------------------------------------
def generate_caption(ai_settings, client_name, sales_link):
    provider = ai_settings.get("provider", "groq")
    system_prompt = ai_settings.get("system_prompt") or "Sos un community manager experto."
    topics = ai_settings.get("topics") or ""
    tone = ai_settings.get("tone") or "cercano y profesional"
    max_chars = ai_settings.get("max_chars") or 400

    user_prompt = (
        f"Negocio: {client_name}. Temas/keywords: {topics}. Tono: {tone}. "
        f"Escribi UNA publicacion nueva y distinta para Instagram/Facebook, maximo {max_chars} caracteres, "
        f"con un cierre que invite a comentar la palabra clave para recibir el link de compra. "
        f"No incluyas el link directamente en el texto. No repitas frases genericas."
    )

    if provider == "openai":
        return _call_openai(system_prompt, user_prompt)
    elif provider == "claude":
        return _call_claude(system_prompt, user_prompt)
    else:
        return _call_groq(system_prompt, user_prompt)


def _call_groq(system_prompt, user_prompt):
    r = requests.post(
        "https://api.groq.com/openai/v1/chat/completions",
        headers={"Authorization": f"Bearer {GROQ_API_KEY}", "Content-Type": "application/json"},
        json={
            "model": "llama-3.3-70b-versatile",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.9,
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
            "temperature": 0.9,
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


# ---------------------------------------------------------------------------
# Publicacion en Meta Graph API
# ---------------------------------------------------------------------------
def publish_facebook(page_id, page_access_token, caption, media_url=None):
    if media_url:
        url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/photos"
        payload = {"url": media_url, "caption": caption, "access_token": page_access_token}
    else:
        url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/feed"
        payload = {"message": caption, "access_token": page_access_token}

    r = requests.post(url, data=payload, timeout=60)
    r.raise_for_status()
    return r.json().get("id") or r.json().get("post_id")


def publish_instagram(ig_business_id, page_access_token, caption, media_url, media_type="image"):
    if not media_url:
        raise ValueError("Instagram requiere si o si una imagen o video (media_url).")

    # Paso 1: crear el contenedor de media
    create_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_business_id}/media"
    payload = {"caption": caption, "access_token": page_access_token}
    payload["video_url" if media_type == "video" else "image_url"] = media_url
    if media_type == "video":
        payload["media_type"] = "REELS"

    r = requests.post(create_url, data=payload, timeout=60)
    r.raise_for_status()
    creation_id = r.json()["id"]

    # Para video, Meta procesa async: esperamos a que el status sea FINISHED
    if media_type == "video":
        status_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{creation_id}"
        for _ in range(20):
            time.sleep(5)
            s = requests.get(status_url, params={"fields": "status_code", "access_token": page_access_token}, timeout=30)
            if s.json().get("status_code") == "FINISHED":
                break

    # Paso 2: publicar el contenedor
    publish_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_business_id}/media_publish"
    r2 = requests.post(publish_url, data={"creation_id": creation_id, "access_token": page_access_token}, timeout=60)
    r2.raise_for_status()
    return r2.json()["id"]


# ---------------------------------------------------------------------------
# Logica principal
# ---------------------------------------------------------------------------
def pick_media(client_id):
    assets = sb_get("socialbot_media_assets", {"client_id": f"eq.{client_id}", "order": "times_used.asc", "limit": "1"})
    if not assets:
        return None
    asset = assets[0]
    sb_update("socialbot_media_assets", {"id": f"eq.{asset['id']}"}, {"times_used": asset["times_used"] + 1})
    return asset


def run():
    now = datetime.now(timezone.utc)
    current_hour = now.hour
    current_minute = now.minute

    # Traemos los horarios activos que coinciden (con tolerancia de +/- 5 min por si el cron no cae justo)
    slots = sb_get("socialbot_schedule_slots", {"active": "eq.true"})
    matching_slots = [s for s in slots if s["hour"] == current_hour and abs(s["minute"] - current_minute) <= 10]

    if not matching_slots:
        print(f"[{now.isoformat()}] No hay horarios que coincidan con {current_hour}:{current_minute:02d} UTC. Nada que hacer.")
        return

    client_ids = list({s["client_id"] for s in matching_slots})
    print(f"Procesando {len(client_ids)} cliente(s) para este horario...")

    for client_id in client_ids:
        try:
            process_client(client_id)
        except Exception as e:
            print(f"ERROR procesando cliente {client_id}: {e}")


def process_client(client_id):
    clients = sb_get("socialbot_clients", {"id": f"eq.{client_id}", "active": "eq.true"})
    if not clients:
        print(f"Cliente {client_id} inactivo o no encontrado, se salta.")
        return
    client = clients[0]

    ai_rows = sb_get("socialbot_ai_settings", {"client_id": f"eq.{client_id}"})
    ai_settings = ai_rows[0] if ai_rows else {"provider": "groq"}

    accounts = sb_get("socialbot_social_accounts", {"client_id": f"eq.{client_id}"})
    if not accounts:
        print(f"Cliente {client['name']}: no tiene cuentas conectadas, se salta.")
        return

    caption = generate_caption(ai_settings, client["name"], client.get("sales_link"))
    media = pick_media(client_id)
    media_url = media["url"] if media else None
    media_type = media["media_type"] if media else None

    for account in accounts:
        post_row = {
            "client_id": client_id,
            "social_account_id": account["id"],
            "caption": caption,
            "media_url": media_url,
            "status": "publishing",
            "scheduled_at": datetime.now(timezone.utc).isoformat(),
        }
        created = sb_insert("socialbot_posts", post_row)[0]

        try:
            if account["platform"] == "facebook":
                external_id = publish_facebook(account["page_id"], account["page_access_token"], caption, media_url)
            else:
                external_id = publish_instagram(
                    account["ig_business_id"], account["page_access_token"], caption, media_url, media_type or "image"
                )

            sb_update(
                "socialbot_posts",
                {"id": f"eq.{created['id']}"},
                {"status": "published", "published_at": datetime.now(timezone.utc).isoformat(), "external_post_id": external_id},
            )
            print(f"OK -> {client['name']} / {account['platform']} / post {external_id}")

        except requests.HTTPError as e:
            error_msg = e.response.text[:500] if e.response is not None else str(e)
            sb_update("socialbot_posts", {"id": f"eq.{created['id']}"}, {"status": "failed", "error_message": error_msg})
            print(f"FALLO -> {client['name']} / {account['platform']}: {error_msg}")


if __name__ == "__main__":
    run()
