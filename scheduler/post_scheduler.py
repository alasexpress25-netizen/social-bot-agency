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
import subprocess
import tempfile
import requests
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

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
def get_app_id_from_token(access_token):
    """
    Obtiene el App ID de Meta directamente desde el propio token (via
    debug_token), en vez de tenerlo hardcodeado. Asi funciona sin importar
    que cliente/app este detras de cada cuenta.
    """
    r = requests.get(
        f"https://graph.facebook.com/{GRAPH_API_VERSION}/debug_token",
        params={"input_token": access_token, "access_token": access_token},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()["data"]["app_id"]


def upload_video_resumable(app_id, access_token, video_url):
    """
    Sube un video a Meta usando la Resumable Upload API (el metodo vigente;
    mandar un file_url directo al endpoint /videos ya no esta soportado).
    Pasos oficiales:
      1) Abrir una sesion de subida contra /{app_id}/uploads
      2) Mandar los bytes del archivo a /upload:{session_id}
      3) Devolver el "file handle" (h) para usar al publicar el video
    """
    head = requests.head(video_url, timeout=30, allow_redirects=True)
    head.raise_for_status()
    file_length = int(head.headers.get("Content-Length", 0))
    if not file_length:
        # Algunos servidores no devuelven Content-Length en HEAD; bajamos
        # el archivo entero para saber el tamano real si hace falta.
        probe = requests.get(video_url, timeout=120)
        probe.raise_for_status()
        file_length = len(probe.content)
    file_name = video_url.split("/")[-1].split("?")[0] or "video.mp4"

    session_resp = requests.post(
        f"https://graph.facebook.com/{GRAPH_API_VERSION}/{app_id}/uploads",
        params={
            "file_name": file_name,
            "file_length": file_length,
            "file_type": "video/mp4",
            "access_token": access_token,
        },
        timeout=30,
    )
    session_resp.raise_for_status()
    upload_session_id = session_resp.json()["id"]  # formato: "upload:XXXXXXXX"

    video_resp = requests.get(video_url, timeout=180)
    video_resp.raise_for_status()

    upload_resp = requests.post(
        f"https://graph.facebook.com/{GRAPH_API_VERSION}/{upload_session_id}",
        headers={"Authorization": f"OAuth {access_token}", "file_offset": "0"},
        data=video_resp.content,
        timeout=180,
    )
    upload_resp.raise_for_status()
    return upload_resp.json()["h"]


def _is_video_permission_error(exc):
    """
    Detecta los errores de permiso de video que tira Meta cuando el token
    tiene Standard Access en vez de Advanced Access para pages_manage_posts.
    Meta usa distintos codigos segun el endpoint:
      - (#100) "No permission to publish the video"  -> endpoint /videos
      - (#200) "does not have permission to post videos on this target" -> /video_reels
    Por eso matcheamos por texto del mensaje ("permission" + "video"), no por
    un unico codigo fijo, para cubrir ambos casos (y cualquier variante
    similar que use Meta) sin enmascarar errores de otro tipo (token
    vencido, red caida, etc.), que no van a mencionar "permission"+"video"
    juntos.
    """
    if exc.response is None:
        return False
    try:
        err = exc.response.json().get("error", {})
    except ValueError:
        return False
    msg = (err.get("message") or "").lower()
    return err.get("code") in (100, 200) and "permission" in msg and "video" in msg


def _fetch_with_retries(url, retries=3, backoff=5, **kwargs):
    """
    GET con reintentos para las descargas de media desde Hostinger, que a
    veces corta la conexion desde los runners de GitHub Actions (ya se vio
    antes con HTTP 206 / webp). No soluciona el problema de fondo -- eso
    esta previsto resolverlo migrando los assets a Cloudinary -- pero
    absorbe los cortes intermitentes mientras tanto.
    """
    last_exc = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.get(url, timeout=kwargs.pop("timeout", 120), **kwargs)
            resp.raise_for_status()
            return resp
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            last_exc = e
            if attempt < retries:
                time.sleep(backoff * attempt)
    raise last_exc
    """
    Publica el video como Reel de Pagina usando el endpoint dedicado
    /video_reels (distinto de /videos). Flujo oficial de 3 fases:
      1) start  -> Meta reserva un video_id y devuelve una upload_url
      2) upload -> le pasamos el file_url del video para que Meta lo baje el mismo
      3) finish -> publicamos el reel con video_state=PUBLISHED
    """
    base = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/video_reels"

    start = requests.post(base, params={"upload_phase": "start", "access_token": page_access_token}, timeout=30)
    start.raise_for_status()
    start_data = start.json()
    video_id = start_data["video_id"]
    upload_url = start_data["upload_url"]

    upload = requests.post(
        upload_url,
        headers={
            "Authorization": f"OAuth {page_access_token}",
            "file_url": video_url,
        },
        timeout=180,
    )
    upload.raise_for_status()

    finish_payload = {
        "upload_phase": "finish",
        "video_id": video_id,
        "video_state": "PUBLISHED",
        "description": caption,
        "access_token": page_access_token,
    }
    if location_id:
        finish_payload["place"] = location_id

    finish = requests.post(base, data=finish_payload, timeout=60)
    finish.raise_for_status()
    return video_id


def extract_video_frame(video_url):
    """
    Descarga el video a un archivo temporal y extrae un frame (segundo 1)
    con ffmpeg, para usarlo como fallback de imagen cuando Facebook no
    permite publicar video (Standard Access). Devuelve la ruta local del
    .jpg generado; el caller es responsable de borrarlo despues.
    """
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp_video:
        video_path = tmp_video.name
        resp = requests.get(video_url, timeout=120, stream=True)
        resp.raise_for_status()
        for chunk in resp.iter_content(chunk_size=1 << 20):
            tmp_video.write(chunk)

    frame_path = video_path.replace(".mp4", ".jpg")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "1", "-i", video_path, "-frames:v", "1", "-q:v", "2", frame_path],
            check=True,
            capture_output=True,
            timeout=60,
        )
    finally:
        os.remove(video_path)

    return frame_path


def publish_facebook_photo_from_file(page_id, page_access_token, caption, file_path, location_id=None):
    """Sube una imagen local (binaria) a la pagina, sin necesitar que tenga URL publica."""
    url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/photos"
    payload = {"caption": caption, "access_token": page_access_token}
    if location_id:
        payload["place"] = location_id
    with open(file_path, "rb") as f:
        r = requests.post(url, data=payload, files={"source": f}, timeout=60)
    r.raise_for_status()
    return r.json().get("id") or r.json().get("post_id")


def publish_facebook(page_id, page_access_token, caption, media_url=None, location_id=None, media_type="image"):
    if media_url and media_type == "video":
        # Intento 1: endpoint dedicado de Reels.
        try:
            return publish_facebook_reel(page_id, page_access_token, caption, media_url, location_id)
        except requests.HTTPError as e:
            if not _is_video_permission_error(e):
                raise

        # Intento 2: endpoint clasico de /videos (resumable upload), por si
        # el permiso se comporta distinto ahi. Si tambien falla por el mismo
        # motivo de permisos, pasamos al fallback de imagen.
        try:
            app_id = get_app_id_from_token(page_access_token)
            file_handle = upload_video_resumable(app_id, page_access_token, media_url)
            url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/videos"
            payload = {
                "fbuploader_video_file_chunk": file_handle,
                "description": caption,
                "access_token": page_access_token,
            }
            if location_id:
                payload["place"] = location_id
            r = requests.post(url, data=payload, timeout=60)
            r.raise_for_status()
            return r.json().get("id") or r.json().get("post_id") or r.json().get("video_id")
        except requests.HTTPError as e:
            if not _is_video_permission_error(e):
                raise

        # Intento 3 (fallback definitivo): publicar un frame del video como foto.
        # Cuando en el futuro se apruebe Advanced Access, los intentos 1/2 de
        # arriba van a funcionar directo y este fallback nunca se va a activar.
        frame_path = extract_video_frame(media_url)
        try:
            photo_id = publish_facebook_photo_from_file(page_id, page_access_token, caption, frame_path, location_id)
            return f"{photo_id} (fallback foto, video no habilitado aun)"
        finally:
            os.remove(frame_path)

    elif media_url:
        url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/photos"
        payload = {"url": media_url, "caption": caption, "access_token": page_access_token}
        if location_id:
            payload["place"] = location_id
        r = requests.post(url, data=payload, timeout=60)
        r.raise_for_status()
        return r.json().get("id") or r.json().get("post_id") or r.json().get("video_id")

    else:
        url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/feed"
        payload = {"message": caption, "access_token": page_access_token}
        if location_id:
            payload["place"] = location_id
        r = requests.post(url, data=payload, timeout=60)
        r.raise_for_status()
        return r.json().get("id") or r.json().get("post_id") or r.json().get("video_id")


def publish_instagram(ig_business_id, page_access_token, caption, media_url, media_type="image", location_id=None):
    if not media_url:
        raise ValueError("Instagram requiere si o si una imagen o video (media_url).")

    # Paso 1: crear el contenedor de media
    create_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_business_id}/media"
    payload = {"caption": caption, "access_token": page_access_token}
    payload["video_url" if media_type == "video" else "image_url"] = media_url
    if media_type == "video":
        payload["media_type"] = "REELS"
    if location_id:
        payload["location_id"] = location_id

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
    return assets[0]


def run():
    now_utc = datetime.now(timezone.utc)

    # Los horarios (hour/minute/day_of_week) estan en la hora LOCAL de cada cliente,
    # no en UTC. Por eso no comparamos una unica "hora actual" global: convertimos
    # now_utc al timezone de CADA cliente antes de comparar contra sus slots.
    slots = sb_get("socialbot_schedule_slots", {"active": "eq.true"})
    if not slots:
        print(f"[{now_utc.isoformat()}] No hay horarios activos configurados. Nada que hacer.")
        return

    clients_by_id = {}
    for client_id in {s["client_id"] for s in slots}:
        rows = sb_get("socialbot_clients", {"id": f"eq.{client_id}"})
        if rows:
            clients_by_id[client_id] = rows[0]

    matching_client_ids = set()
    for slot in slots:
        client = clients_by_id.get(slot["client_id"])
        if not client:
            continue

        tz_name = client.get("timezone") or "America/Sao_Paulo"
        try:
            local_now = now_utc.astimezone(ZoneInfo(tz_name))
        except Exception as e:
            print(f"Timezone invalido '{tz_name}' para cliente {slot['client_id']}: {e}. Se salta.")
            continue

        # day_of_week: 1=Lunes..7=Domingo (ISO). NULL = aplica todos los dias.
        if slot.get("day_of_week") is not None and slot["day_of_week"] != local_now.isoweekday():
            continue

        # Tolerancia de +/- 10 min por si el cron no cae exactamente justo
        slot_minutes = slot["hour"] * 60 + slot["minute"]
        now_minutes = local_now.hour * 60 + local_now.minute
        if abs(slot_minutes - now_minutes) <= 10:
            matching_client_ids.add(slot["client_id"])

    if not matching_client_ids:
        print(f"[{now_utc.isoformat()}] Ningun horario coincide con la hora local de algun cliente. Nada que hacer.")
        return

    print(f"Procesando {len(matching_client_ids)} cliente(s) para este horario...")

    for client_id in matching_client_ids:
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

    media = pick_media(client_id)
    media_url = media["url"] if media else None
    media_type = media["media_type"] if media else None
    media_published_ok = False

    # Si el media tiene un caption_override cargado (texto fijo escrito a mano,
    # con hashtags y CTA incluidos), lo usamos tal cual y NO llamamos a la IA.
    # Si no, generamos un caption nuevo automaticamente como antes.
    if media and media.get("caption_override"):
        caption = media["caption_override"]
    else:
        caption = generate_caption(ai_settings, client["name"], client.get("sales_link"))

    for account in accounts:
        location_id = media.get("location_id_override") if media else None

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
                external_id = publish_facebook(
                    account["page_id"], account["page_access_token"], caption, media_url, location_id, media_type or "image"
                )
            else:
                external_id = publish_instagram(
                    account["ig_business_id"],
                    account["page_access_token"],
                    caption,
                    media_url,
                    media_type or "image",
                    location_id,
                )

            sb_update(
                "socialbot_posts",
                {"id": f"eq.{created['id']}"},
                {"status": "published", "published_at": datetime.now(timezone.utc).isoformat(), "external_post_id": external_id},
            )
            print(f"OK -> {client['name']} / {account['platform']} / post {external_id}")
            media_published_ok = True

        except requests.HTTPError as e:
            error_msg = e.response.text[:500] if e.response is not None else str(e)
            sb_update("socialbot_posts", {"id": f"eq.{created['id']}"}, {"status": "failed", "error_message": error_msg})
            print(f"FALLO -> {client['name']} / {account['platform']}: {error_msg}")

    # Solo contamos el media como "usado" si se publico de verdad en al menos
    # una cuenta. Si todo fallo, el media sigue con su times_used original y
    # va a volver a ser el candidato mas prioritario en el proximo intento.
    if media and media_published_ok:
        sb_update("socialbot_media_assets", {"id": f"eq.{media['id']}"}, {"times_used": media["times_used"] + 1})


if __name__ == "__main__":
    run()
