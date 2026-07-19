"""
post_scheduler.py
------------------
Se ejecuta cada 15 minutos (via GitHub Actions cron) y para cada cliente
activo que tenga un horario (schedule_slot) que coincida con la hora actual:

  1. Si hay un item del plan semanal de contenido (Fase 6, generado por
     content_planner.py) ya APROBADO por la agencia para el dia de hoy,
     usa ese caption tal cual (sin volver a pasar por la IA). Si no, sigue
     la logica de siempre: caption_override del media, o generacion con IA
     en el momento (OpenAI/Claude/Groq, segun ai_settings.provider).
  2. Elige una imagen/video/carrusel de la biblioteca del cliente (media_assets)
  3. Si el cliente tiene require_approval=true, guarda el post como pendiente
     de aprobacion y NO publica todavia (el cliente lo aprueba/rechaza, y
     puede editar el texto, desde su portal, frontend/cliente.html). Si no,
     publica directo como siempre.
  4. Publica en Facebook y/o Instagram via Meta Graph API
  5. Guarda el resultado en la tabla `posts` de Supabase

Ademas, en cada corrida:
  - ANTES de generar posts nuevos, revisa si hay posts que ya estaban
    esperando aprobacion y el cliente ya aprobo desde su portal, y los
    publica (publish_approved_pending_posts()).
  - Tambien ANTES de generar posts nuevos, actualiza en
    socialbot_post_metrics (likes/comments/shares/reach/impressions) los
    posts publicados en los ultimos 30 dias, trayendo los numeros reales
    desde Meta Graph API (collect_post_metrics()). Esto es lo que despues
    usa content_planner.py (Fase 6) para saber que angulo/formato funciono
    mejor con cada cliente.

No requiere servidor: corre como un job de GitHub Actions y termina.
Todas las credenciales sensibles viven en Supabase (por cliente) o en
GitHub Secrets (claves generales: Supabase service key, OpenAI/Claude key).
"""

import os
import sys
import time
import json
import random
import socket
import threading
import subprocess
import tempfile
import requests
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------
# Forzar IPv4 en todas las conexiones salientes.
# ---------------------------------------------------------------------------
# Hostinger (lavisualmk.alastecno.com) resuelve tanto en IPv4 como en IPv6.
# Los runners de GitHub Actions a veces no tienen ruta de salida IPv6
# completa, entonces al intentar conectar por IPv6 primero tira
# "[Errno 101] Network is unreachable" aunque el sitio ande perfecto por
# IPv4. Este parche obliga a que TODO el DNS resuelto por el proceso
# (requests, urllib3, etc.) devuelva solo direcciones IPv4.
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_only_getaddrinfo

# ---------------------------------------------------------------------------
# Config general (viene de GitHub Secrets -> variables de entorno)
# ---------------------------------------------------------------------------
SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]  # service_role key (NUNCA la anon key acá)
GRAPH_API_VERSION = os.environ.get("GRAPH_API_VERSION", "v21.0")

# collect_post_metrics(): despues de esta cantidad de fallos consecutivos
# trayendo metricas de un post (ej. el cliente lo borro, oculto los likes,
# etc.), se deja de reintentar en cada corrida y pasa a reintentarse solo 1
# vez cada RETRY_COOLDOWN_HOURS horas. Ver migracion 0017.
MAX_METRICS_FETCH_FAILURES = 3
RETRY_COOLDOWN_HOURS = 24

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


def sb_upsert(table, rows, on_conflict):
    """
    Insert-or-update por una clave unica (ej. post_id en
    socialbot_post_metrics, que tiene "unique" sobre esa columna).
    """
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates,return=representation"},
        params={"on_conflict": on_conflict},
        json=rows,
        timeout=30,
    )
    r.raise_for_status()
    return r.json()


# ---------------------------------------------------------------------------
# Generacion de texto con IA
# ---------------------------------------------------------------------------
def generate_caption(ai_settings, client_name, sales_link):
    provider = ai_settings.get("provider", "groq")
    system_prompt = ai_settings.get("system_prompt") or "Sos un community manager experto."
    topics = ai_settings.get("topics") or ""
    tone = ai_settings.get("tone") or "cercano y profesional"
    max_chars = ai_settings.get("max_chars") or 400
    knowledge_base = ai_settings.get("knowledge_base") or ""

    # Base de conocimiento del negocio (servicios, precios reales, FAQ,
    # politicas): si esta cargada, se la damos a la IA como fuente de verdad,
    # asi los posts que genera son consistentes con lo que el negocio
    # realmente ofrece, en vez de inventar generalidades.
    knowledge_line = (
        f"Informacion real del negocio (usala como fuente de verdad para no inventar precios/datos): {knowledge_base}. "
        if knowledge_base else ""
    )

    user_prompt = (
        f"Negocio: {client_name}. Temas/keywords: {topics}. Tono: {tone}. "
        f"{knowledge_line}"
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
# FASE 6: uso del plan semanal de contenido ya aprobado
# ---------------------------------------------------------------------------
def get_approved_plan_item_for_today(client_id):
    """
    Busca, para este cliente, un item de socialbot_content_plan_items con
    status='approved' cuyo target_date sea el dia de hoy (fecha UTC, mismo
    criterio que usa content_planner.py al calcular week_start/target_date,
    para que ambos scripts esten de acuerdo en que dia es "hoy"). Si existe,
    ese caption se usa tal cual y NO se llama a la IA en el momento.
    """
    today = datetime.now(timezone.utc).date().isoformat()
    items = sb_get(
        "socialbot_content_plan_items",
        {
            "client_id": f"eq.{client_id}",
            "target_date": f"eq.{today}",
            "status": "eq.approved",
            "limit": "1",
        },
    )
    return items[0] if items else None


def mark_plan_item_used(plan_item_id, used_post_id):
    sb_update(
        "socialbot_content_plan_items",
        {"id": f"eq.{plan_item_id}"},
        {"status": "used", "used_post_id": used_post_id},
    )


# ---------------------------------------------------------------------------
# FASE 6: recoleccion de metricas de posts publicados (Meta Graph API)
# ---------------------------------------------------------------------------
def _clean_external_id(raw_id):
    """
    external_post_id a veces viene con un sufijo legible agregado por
    publish_facebook() (ej. "12345 (foto manual)" o "12345 (fallback foto,
    video no habilitado aun)") para que se entienda en el panel que paso.
    Para pegarle a Graph API necesitamos solo el id real, antes del espacio.
    """
    if not raw_id:
        return None
    return raw_id.split(" ")[0]


def _build_permalink(platform, raw_external_id, access_token):
    """
    Item 15 de PROPUESTAS-AGENCIA.md ("Link a la publicación real").

    Facebook: NO alcanza con armar "facebook.com/{id}" a mano -- eso solo
    funciona para posts de Página "normales". Cuando el video falla y se
    sube una foto de fallback (o una foto manual), Meta devuelve el ID de
    un objeto Photo, y ese tipo de objeto no soporta el campo
    "permalink_url" (tira error "nonexisting field"); en cambio SI expone
    "link" (con formato photo.php?fbid=...&set=...). Para no adivinar mal
    el tipo de objeto, probamos permalink_url primero y, si ese campo no
    existe para este objeto puntual, reintentamos con link. Si Meta
    devuelve una ruta relativa (le pasa a veces con permalink_url en
    reels, ej. "/reel/123/"), se completa con el dominio.

    Instagram: el media id no arma una URL valida por si solo, asi que se
    pide el field 'permalink' a Graph API (ese si devuelve URL absoluta
    siempre).

    Best-effort: si todo falla, devuelve None (o, para Facebook, la URL
    generica de siempre) y no rompe el flujo de publicacion (el post ya se
    publico igual).
    """
    clean_id = _clean_external_id(raw_external_id)
    if not clean_id:
        return None

    if platform == "facebook":
        for field in ("permalink_url", "link"):
            try:
                r = requests.get(
                    f"https://graph.facebook.com/{GRAPH_API_VERSION}/{clean_id}",
                    params={"fields": field, "access_token": access_token},
                    timeout=15,
                )
                r.raise_for_status()
                value = r.json().get(field)
                if value:
                    return value if value.startswith("http") else f"https://www.facebook.com{value}"
            except Exception as e:
                print(f"[_build_permalink] campo '{field}' no disponible para {clean_id}: {e}")
                continue
        # Ningun campo funciono (objeto sin permiso, o tipo no contemplado
        # arriba) -- como ultimo recurso, la URL generica de siempre.
        return f"https://www.facebook.com/{clean_id}"

    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{clean_id}",
            params={"fields": "permalink", "access_token": access_token},
            timeout=15,
        )
        r.raise_for_status()
        return r.json().get("permalink")
    except Exception as e:
        print(f"[_build_permalink] no se pudo obtener permalink para {clean_id}: {e}")
        return None


def _fetch_facebook_post_insights(post_id, access_token):
    """Reach/impressions de un post de Pagina. Best-effort: si Meta no tiene
    el dato todavia (posts muy recientes) o el permiso no alcanza, no rompe
    nada -- simplemente esas columnas quedan en null."""
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{post_id}/insights",
            params={"metric": "post_impressions,post_impressions_unique", "access_token": access_token},
            timeout=30,
        )
        r.raise_for_status()
        values = {d["name"]: d["values"][0]["value"] for d in r.json().get("data", []) if d.get("values")}
        return values.get("post_impressions_unique"), values.get("post_impressions")
    except Exception:
        return None, None


def _fetch_instagram_reach(media_id, access_token):
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{media_id}/insights",
            params={"metric": "reach", "access_token": access_token},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json().get("data", [])
        if data and data[0].get("values"):
            return data[0]["values"][0]["value"]
        return None
    except Exception:
        return None


def _fetch_facebook_shares(post_id, access_token):
    """
    'shares' se pide por separado del resto de los campos (likes, comments) a
    proposito. Es un bug historico y documentado de la Graph API: cuando un
    post de Facebook tiene 0 shares, el campo 'shares' directamente no existe
    en el objeto, y pedirlo junto con otros campos en un mismo fields=...
    tira "(#100) Tried accessing nonexistent field (shares)" -- y ese error
    tumba TODA la respuesta, no solo el campo 'shares' (perdiendo tambien
    likes/comments que si estaban disponibles). Por eso va aislado y
    best-effort: si falla, asumimos 0 shares en vez de perder el resto de
    las metricas del post.
    """
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{post_id}",
            params={"fields": "shares", "access_token": access_token},
            timeout=30,
        )
        r.raise_for_status()
        return r.json().get("shares", {}).get("count", 0)
    except Exception:
        return 0


def fetch_post_metrics(platform, external_id, access_token):
    """
    Devuelve un dict {likes, comments, shares, reach, impressions} o None si
    no se pudo traer nada (post borrado, token vencido, etc. -- se loguea y
    se sigue con el resto, no corta la corrida).
    """
    try:
        if platform == "facebook":
            r = requests.get(
                f"https://graph.facebook.com/{GRAPH_API_VERSION}/{external_id}",
                params={"fields": "likes.summary(true),comments.summary(true)", "access_token": access_token},
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            likes = data.get("likes", {}).get("summary", {}).get("total_count", 0)
            comments = data.get("comments", {}).get("summary", {}).get("total_count", 0)
            shares = _fetch_facebook_shares(external_id, access_token)
            reach, impressions = _fetch_facebook_post_insights(external_id, access_token)
            return {"likes": likes, "comments": comments, "shares": shares, "reach": reach, "impressions": impressions}
        else:
            r = requests.get(
                f"https://graph.facebook.com/{GRAPH_API_VERSION}/{external_id}",
                params={"fields": "like_count,comments_count", "access_token": access_token},
                timeout=30,
            )
            r.raise_for_status()
            data = r.json()
            likes = data.get("like_count", 0)
            comments = data.get("comments_count", 0)
            reach = _fetch_instagram_reach(external_id, access_token)
            return {"likes": likes, "comments": comments, "shares": 0, "reach": reach, "impressions": None}
    except requests.HTTPError as e:
        detail = e.response.text[:200] if e.response is not None else str(e)
        print(f"No se pudieron traer metricas de {platform} {external_id}: {detail}")
        return None
    except Exception as e:
        print(f"No se pudieron traer metricas de {platform} {external_id}: {e}")
        return None


def collect_post_metrics():
    """
    Recorre los posts publicados en los ultimos 30 dias, trae sus numeros
    reales (likes/comments/shares/reach/impressions) desde Meta Graph API, y
    los guarda (upsert por post_id) en socialbot_post_metrics. Se corre al
    principio de cada ejecucion del scheduler, junto con
    publish_approved_pending_posts(). Es lo que content_planner.py (Fase 6)
    despues usa para saber que angulo/formato funciono mejor con cada
    cliente -- sin esto, la tabla socialbot_post_metrics quedaba vacia para
    siempre y el plan semanal no tenia datos reales de performance.

    Algunos posts fallan siempre (el cliente borro el post desde Instagram/
    Facebook, oculto los likes, cambiaron permisos de la Pagina, etc.) -- no
    hay forma de distinguir esto de un fallo transitorio en el momento, asi
    que en vez de reintentar para siempre en cada corrida (ruido en el log +
    llamadas de API desperdiciadas sin beneficio), despues de
    MAX_METRICS_FETCH_FAILURES fallos consecutivos el post pasa a
    reintentarse solo 1 vez cada RETRY_COOLDOWN_HOURS horas -- por si el
    problema se resolvio solo (ej. la Pagina recupero permisos), sin
    machacar la API mientras tanto.
    """
    since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    retry_cutoff = (datetime.now(timezone.utc) - timedelta(hours=RETRY_COOLDOWN_HOURS)).isoformat()
    posts = sb_get(
        "socialbot_posts",
        {
            "status": "eq.published",
            "published_at": f"gte.{since}",
            "or": (
                f"(metrics_fetch_failures.lt.{MAX_METRICS_FETCH_FAILURES},"
                f"metrics_last_fetch_attempt.is.null,"
                f"metrics_last_fetch_attempt.lt.{retry_cutoff})"
            ),
            "select": "id,external_post_id,social_account_id,metrics_fetch_failures",
        },
    )
    if not posts:
        return

    print(f"Actualizando metricas de {len(posts)} post(s) publicado(s) en los ultimos 30 dias...")
    updated = 0
    skipped_in_cooldown = 0
    for post in posts:
        clean_id = _clean_external_id(post.get("external_post_id"))
        if not clean_id:
            continue

        prior_failures = post.get("metrics_fetch_failures") or 0
        if prior_failures >= MAX_METRICS_FETCH_FAILURES:
            skipped_in_cooldown += 1

        def _record_fetch_failure():
            new_failures = prior_failures + 1
            sb_update(
                "socialbot_posts",
                {"id": f"eq.{post['id']}"},
                {"metrics_fetch_failures": new_failures, "metrics_last_fetch_attempt": datetime.now(timezone.utc).isoformat()},
            )
            if new_failures == MAX_METRICS_FETCH_FAILURES:
                print(f"  Post {post['id']}: {MAX_METRICS_FETCH_FAILURES} fallos seguidos trayendo metricas, paso a reintentarse solo 1 vez cada {RETRY_COOLDOWN_HOURS}h en vez de en cada corrida.")

        try:
            accounts = sb_get("socialbot_social_accounts", {"id": f"eq.{post['social_account_id']}"})
            if not accounts:
                continue
            account = accounts[0]

            metrics = fetch_post_metrics(account["platform"], clean_id, account["page_access_token"])
            if metrics is None:
                _record_fetch_failure()
                continue

            sb_upsert(
                "socialbot_post_metrics",
                [{"post_id": post["id"], **metrics, "fetched_at": datetime.now(timezone.utc).isoformat()}],
                on_conflict="post_id",
            )
            if prior_failures:
                sb_update(
                    "socialbot_posts",
                    {"id": f"eq.{post['id']}"},
                    {"metrics_fetch_failures": 0, "metrics_last_fetch_attempt": None},
                )
            updated += 1
        except Exception as e:
            print(f"ERROR actualizando metricas del post {post['id']}: {e}")
            try:
                _record_fetch_failure()
            except Exception as e2:
                print(f"  (ademas, no se pudo registrar el fallo en socialbot_posts: {e2})")

    cooldown_note = f" ({skipped_in_cooldown} en cooldown, reintentados igual esta vez)" if skipped_in_cooldown else ""
    print(f"Metricas actualizadas: {updated}/{len(posts)}.{cooldown_note}")


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
    head = _request_with_retries("HEAD", video_url, timeout=30, allow_redirects=True)
    file_length = int(head.headers.get("Content-Length", 0))
    if not file_length:
        # Algunos servidores no devuelven Content-Length en HEAD; bajamos
        # el archivo entero para saber el tamano real si hace falta.
        probe = _fetch_with_retries(video_url, timeout=120)
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

    video_resp = _fetch_with_retries(video_url, timeout=180)

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
    if err.get("code") not in (100, 200):
        return False
    if "permission" in msg and "video" in msg:
        return True
    # Variante vista en la practica: Meta devuelve (#200) quejandose del
    # permiso legacy "publish_actions" (deprecado hace anos) en vez de
    # mencionar "video" explicitamente. Tambien es, en los hechos, un
    # bloqueo de permisos de publicacion -> debe activar el fallback.
    if "permission" in msg and "publish_actions" in msg:
        return True
    return False


def _is_transient_media_fetch_error(exc):
    """
    Detecta el caso visto en produccion: el crawler de Meta intenta bajar
    el video desde Hostinger (file_url) y Hostinger le responde 429 Too
    Many Requests -- normalmente porque Instagram y Facebook piden el
    mismo archivo casi al mismo tiempo, o porque el hosting compartido
    esta momentaneamente saturado. Es un error transitorio de red, no de
    permisos ni de contenido, y el fix correcto es reintentar / cambiar de
    estrategia de subida (ver publish_facebook()), nunca abortar el post.

    Se busca sobre el texto crudo de la respuesta en vez de sobre una unica
    key JSON porque Meta usa formatos distintos segun el endpoint que
    devuelve el error: a veces envuelve todo en {"error": {...}}, y en el
    endpoint de subida de /video_reels (rupload.facebook.com) el error real
    viene directo en la raiz como {"debug_info": {"type": "FileUrlProcessingError", ...}}.
    """
    if exc.response is None:
        return False
    text = (exc.response.text or "").lower()
    if not text:
        return False
    if "fileurlprocessingerror" in text:
        return True
    if "unable to fetch media" in text:
        return True
    if exc.response.status_code == 429:
        return True
    if "429" in text and ("too many requests" in text or "rate limit" in text):
        return True
    # Meta a veces devuelve un error generico de procesamiento (code 6000,
    # subcode 1363019, "Espera unos minutos y vuelve a intentarlo.") que no
    # tiene nada que ver con permisos ni con el contenido del archivo -- es
    # un hipo transitorio del lado de Meta al procesar el video subido. Lo
    # tratamos igual que los demas errores transitorios: seguir con el
    # siguiente intento (resumable upload / fallback de frame) en vez de
    # abortar el post entero.
    if "1363019" in text:
        return True
    return False


def _run_with_hard_timeout(fn, timeout_seconds):
    """
    Corre fn() con un limite de tiempo TOTAL real, a diferencia del
    timeout=... de requests (que es por operacion de socket -- conectar o
    leer -- no un limite de tiempo total del request). Si el servidor
    mantiene la conexion viva con datos intermitentes (algo que Meta hace
    en llamadas largas como el upload de /video_reels mientras su crawler
    intenta bajar el archivo de origen), requests puede tardar mucho mas
    que el timeout declarado sin nunca disparar una excepcion.

    Visto en produccion: publish_facebook_reel() quedo colgado 15+ minutos
    en la fase "upload" con Hostinger caido para ese cliente, muy por
    encima de los 180s de timeout declarados, porque cada lectura individual
    del socket entraba dentro del limite aunque el total no.

    Si fn() no termina a tiempo, dejamos de esperarla (no se puede matar un
    thread en Python a la fuerza; el request de fondo se abandona y termina
    solo eventualmente) y tratamos esto como timeout real, para que el
    caller pueda caer al siguiente intento en vez de quedarse colgado.
    """
    box = {}

    def _target():
        try:
            box["value"] = fn()
        except Exception as e:
            box["error"] = e

    t = threading.Thread(target=_target, daemon=True)
    t.start()
    t.join(timeout_seconds)
    if t.is_alive():
        raise TimeoutError(f"la operacion no devolvio nada en {timeout_seconds}s (conexion probablemente colgada del lado del servidor)")
    if "error" in box:
        raise box["error"]
    return box["value"]


def _request_with_retries(method, url, retries=3, backoff=5, **kwargs):
    """
    Request (GET/HEAD) con reintentos para las descargas de media desde
    Hostinger, que a veces corta la conexion desde los runners de GitHub
    Actions (ya se vio antes con HTTP 206 / webp) y que, bajo carga (dos
    crawlers de Meta pidiendo el mismo archivo casi al mismo tiempo),
    responde HTTP 429 Too Many Requests. No soluciona el problema de fondo
    -- eso esta previsto resolverlo migrando los assets a Cloudinary --
    pero absorbe los cortes/rate-limits intermitentes mientras tanto.
    """
    timeout = kwargs.pop("timeout", 120)
    last_exc = None
    for attempt in range(1, retries + 1):
        try:
            resp = requests.request(method, url, timeout=timeout, **kwargs)
            if resp.status_code == 429 and attempt < retries:
                wait = backoff * attempt
                retry_after = resp.headers.get("Retry-After")
                if retry_after:
                    try:
                        wait = max(wait, float(retry_after))
                    except ValueError:
                        pass
                print(f"  (retry) 429 de {url[:80]}..., esperando {wait:.0f}s antes de reintentar (intento {attempt}/{retries})")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return resp
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            last_exc = e
            if attempt < retries:
                time.sleep(backoff * attempt)
        except requests.HTTPError as e:
            last_exc = e
            if attempt < retries and e.response is not None and e.response.status_code == 429:
                wait = backoff * attempt
                print(f"  (retry) 429 de {url[:80]}..., esperando {wait:.0f}s antes de reintentar (intento {attempt}/{retries})")
                time.sleep(wait)
                continue
            raise
    raise last_exc


def _fetch_with_retries(url, retries=3, backoff=5, **kwargs):
    """GET con reintentos. Ver _request_with_retries (incluye manejo de 429)."""
    return _request_with_retries("GET", url, retries=retries, backoff=backoff, **kwargs)


def publish_facebook_reel(page_id, page_access_token, caption, video_url, location_id=None):
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

    # timeout=180 de requests no alcanza aca: es un timeout por-lectura, no
    # total. Si Meta mantiene la conexion viva con datos intermitentes
    # mientras su crawler intenta (y no logra) bajar el video de Hostinger,
    # esta llamada puede colgarse mucho mas alla de los 180s declarados (se
    # vio en produccion, 15+ minutos). _run_with_hard_timeout pone un techo
    # real: si no volvio en 90s, lo tratamos como fallo transitorio y
    # dejamos que publish_facebook() caiga al intento 2.
    upload = _run_with_hard_timeout(
        lambda: requests.post(
            upload_url,
            headers={
                "Authorization": f"OAuth {page_access_token}",
                "file_url": video_url,
            },
            timeout=180,
        ),
        timeout_seconds=90,
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
        resp = _fetch_with_retries(video_url, timeout=120, stream=True)
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


def publish_facebook_carousel(page_id, page_access_token, caption, image_urls, location_id=None):
    """
    Publica varias imagenes juntas como un unico post ("carrusel") en la
    Pagina de Facebook. Flujo oficial de 2 pasos:
      1) Subir cada imagen como foto NO publicada (published=false) via
         /{page-id}/photos -> queda "guardada" con un id, sin aparecer sola
         en el feed.
      2) Crear el post real en /{page-id}/feed adjuntando esas fotos con
         attached_media[N]={"media_fbid": "<id>"}.
    """
    photo_ids = []
    for url in image_urls:
        r = requests.post(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/photos",
            data={"url": url, "published": "false", "access_token": page_access_token},
            timeout=60,
        )
        r.raise_for_status()
        photo_ids.append(r.json()["id"])

    payload = {"message": caption, "access_token": page_access_token}
    for i, photo_id in enumerate(photo_ids):
        payload[f"attached_media[{i}]"] = json.dumps({"media_fbid": photo_id})
    if location_id:
        payload["place"] = location_id

    r2 = requests.post(f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/feed", data=payload, timeout=60)
    r2.raise_for_status()
    return r2.json().get("id") or r2.json().get("post_id")


def publish_facebook(page_id, page_access_token, caption, media_url=None, location_id=None, media_type="image", fb_photo_override=None, carousel_urls=None):
    if media_type == "carousel" and carousel_urls:
        return publish_facebook_carousel(page_id, page_access_token, caption, carousel_urls, location_id)

    if media_url and media_type == "video":
        # Si el cliente cargo una foto manual especifica para Facebook (capturada
        # a mano en vez de depender del frame auto-extraido), la usamos directo y
        # ni siquiera intentamos el video en Facebook. Instagram sigue publicando
        # el video normalmente (esto no lo afecta, ver publish_instagram).
        if fb_photo_override:
            print("Facebook: usando foto manual cargada por el cliente (fb_photo_url), se salta el video.")
            url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/photos"
            payload = {"url": fb_photo_override, "caption": caption, "access_token": page_access_token}
            if location_id:
                payload["place"] = location_id
            r = requests.post(url, data=payload, timeout=60)
            r.raise_for_status()
            photo_id = r.json().get("id") or r.json().get("post_id")
            return f"{photo_id} (foto manual)"

        # Intento 1: endpoint dedicado de Reels.
        try:
            print("Facebook: intento 1 (video_reels)...")
            return publish_facebook_reel(page_id, page_access_token, caption, media_url, location_id)
        except TimeoutError as e:
            # Watchdog de _run_with_hard_timeout: la fase "upload" no volvio
            # en 90s (Meta probablemente colgado esperando a un Hostinger
            # que no responde). Mismo razonamiento que el resto de errores
            # transitorios: el intento 2 baja el archivo el mismo script, no
            # depende de que Meta pueda llegar a Hostinger.
            print(f"Facebook: intento 1 se colgo ({e}), sigo con intento 2.")
        except requests.HTTPError as e:
            if _is_video_permission_error(e):
                print(f"Facebook: intento 1 fallo por permiso de video ({e.response.text[:200]}), sigo con intento 2.")
            elif _is_transient_media_fetch_error(e):
                # El crawler de Meta no pudo bajar el video de Hostinger (429 /
                # FileUrlProcessingError), tipicamente porque Instagram acaba
                # de pedir el mismo archivo segundos antes. El intento 2 no
                # depende de que Meta vuelva a golpear a Hostinger: es este
                # propio script el que baja el archivo (con reintentos/backoff,
                # ver upload_video_resumable) y le sube los bytes a Meta
                # directamente, asi que evita el problema de raiz.
                print(f"Facebook: intento 1 fallo por rate-limit/timeout de Hostinger al bajar el video ({e.response.text[:200]}), sigo con intento 2.")
            else:
                raise

        # Intento 2: endpoint clasico de /videos (resumable upload), por si
        # el permiso se comporta distinto ahi. Si tambien falla por el mismo
        # motivo de permisos, pasamos al fallback de imagen.
        try:
            print("Facebook: intento 2 (videos resumable upload)...")
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
            if _is_video_permission_error(e):
                print(f"Facebook: intento 2 fallo por permiso de video ({e.response.text[:200]}), sigo con intento 3 (foto auto).")
            elif _is_transient_media_fetch_error(e):
                # upload_video_resumable ya reintenta con backoff (incl. 429)
                # al bajar el video; si aun asi se agotaron los reintentos,
                # no tiene sentido reintentar de nuevo aca -- vamos directo al
                # fallback de foto para no perder el post completo.
                print(f"Facebook: intento 2 tambien fallo por rate-limit/timeout persistente de Hostinger ({e.response.text[:200]}), sigo con intento 3 (foto auto).")
            else:
                raise

        # Intento 3 (fallback definitivo): publicar un frame del video como foto.
        # Cuando en el futuro se apruebe Advanced Access, los intentos 1/2 de
        # arriba van a funcionar directo y este fallback nunca se va a activar.
        print("Facebook: intento 3 (extrayendo frame del video con ffmpeg)...")
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


def publish_instagram_carousel(ig_business_id, page_access_token, caption, image_urls, location_id=None):
    """
    Publica un carrusel de imagenes en Instagram. Flujo oficial:
      1) Crear un contenedor "hijo" por cada imagen, marcado como
         is_carousel_item=true (NO se publica solo, queda a la espera).
      2) Crear el contenedor "padre" de tipo CAROUSEL, apuntando a esos
         hijos via 'children'.
      3) Publicar el contenedor padre normalmente (media_publish).
    Instagram exige entre 2 y 10 items para un carrusel.
    """
    if len(image_urls) < 2:
        raise ValueError("Instagram requiere al menos 2 imagenes para un carrusel.")
    if len(image_urls) > 10:
        image_urls = image_urls[:10]

    child_ids = []
    for url in image_urls:
        r = requests.post(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_business_id}/media",
            data={"image_url": url, "is_carousel_item": "true", "access_token": page_access_token},
            timeout=60,
        )
        r.raise_for_status()
        child_ids.append(r.json()["id"])

    create_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_business_id}/media"
    payload = {
        "caption": caption,
        "media_type": "CAROUSEL",
        "children": ",".join(child_ids),
        "access_token": page_access_token,
    }
    if location_id:
        payload["location_id"] = location_id

    r = requests.post(create_url, data=payload, timeout=60)
    r.raise_for_status()
    creation_id = r.json()["id"]

    publish_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_business_id}/media_publish"
    r2 = requests.post(publish_url, data={"creation_id": creation_id, "access_token": page_access_token}, timeout=60)
    r2.raise_for_status()
    return r2.json()["id"]


def publish_instagram(ig_business_id, page_access_token, caption, media_url, media_type="image", location_id=None, carousel_urls=None):
    if media_type == "carousel" and carousel_urls:
        return publish_instagram_carousel(ig_business_id, page_access_token, caption, carousel_urls, location_id)

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

    # Para video, Meta procesa async: esperamos a que el status sea FINISHED.
    # Videos mas pesados (como reels largos) pueden tardar varios minutos en
    # procesarse del lado de Meta -- por eso esperamos hasta ~6 minutos en
    # total antes de rendirnos, y cortamos antes si Meta ya avisa error.
    if media_type == "video":
        status_url = f"https://graph.facebook.com/{GRAPH_API_VERSION}/{creation_id}"
        finished = False
        for _ in range(70):
            time.sleep(5)
            s = requests.get(status_url, params={"fields": "status_code", "access_token": page_access_token}, timeout=30)
            status_code = s.json().get("status_code")
            if status_code == "FINISHED":
                finished = True
                break
            if status_code in ("ERROR", "EXPIRED"):
                raise RuntimeError(f"Instagram: el video quedo en estado '{status_code}' al procesarse (creation_id {creation_id}).")
        if not finished:
            raise RuntimeError(
                f"Instagram: el video siguio sin terminar de procesarse despues de ~6 minutos "
                f"(creation_id {creation_id}). Puede reintentarse mas tarde."
            )

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


def get_carousel_urls(media_asset_id):
    items = sb_get("socialbot_carousel_items", {"media_asset_id": f"eq.{media_asset_id}", "order": "position.asc"})
    return [it["url"] for it in items]


def publish_approved_pending_posts():
    """
    Busca posts que quedaron en status='pending' (generados pero no
    publicados porque el cliente tenia require_approval=true) y cuyo
    approval_status ya paso a 'approved' desde el portal de cliente
    (frontend/cliente.html) -- donde ademas pudo haber editado el texto
    del caption antes de aprobar -- y los publica ahora. Los rechazados
    (approval_status='rejected') se ignoran para siempre: quedan como
    registro historico, sin publicarse nunca.

    Se corre al principio de cada ejecucion del scheduler, antes de generar
    posts nuevos.
    """
    pending = sb_get("socialbot_posts", {"status": "eq.pending", "approval_status": "eq.approved"})
    if not pending:
        return

    print(f"Publicando {len(pending)} post(s) aprobado(s) por el cliente...")
    for post in pending:
        accounts = sb_get("socialbot_social_accounts", {"id": f"eq.{post['social_account_id']}"})
        if not accounts:
            sb_update("socialbot_posts", {"id": f"eq.{post['id']}"}, {"status": "failed", "error_message": "cuenta social no encontrada"})
            continue
        account = accounts[0]

        # Reconstruimos el media (si tiene) por referencia directa al
        # media_asset_id guardado en el post -- ya no adivinamos por 'url',
        # que ademas no alcanza para carruseles (no tienen una unica url).
        media = None
        if post.get("media_asset_id"):
            assets = sb_get("socialbot_media_assets", {"id": f"eq.{post['media_asset_id']}"})
            media = assets[0] if assets else None

        media_type = post.get("media_type") or (media.get("media_type") if media else "image") or "image"
        carousel_urls = get_carousel_urls(media["id"]) if (media and media_type == "carousel") else None

        try:
            if account["platform"] == "facebook":
                external_id = publish_facebook(
                    account["page_id"],
                    account["page_access_token"],
                    post["caption"],
                    post.get("media_url"),
                    media.get("location_id_override") if media else None,
                    media_type,
                    media.get("fb_photo_url") if media else None,
                    carousel_urls,
                )
            else:
                external_id = publish_instagram(
                    account["ig_business_id"],
                    account["page_access_token"],
                    post["caption"],
                    post.get("media_url"),
                    media_type,
                    media.get("location_id_override") if media else None,
                    carousel_urls,
                )
            permalink = _build_permalink(account["platform"], external_id, account["page_access_token"])
            sb_update(
                "socialbot_posts",
                {"id": f"eq.{post['id']}"},
                {"status": "published", "published_at": datetime.now(timezone.utc).isoformat(), "external_post_id": external_id, "permalink_url": permalink},
            )
            print(f"OK (aprobado por cliente) -> post {post['id']}")
        except Exception as e:
            error_msg = e.response.text[:500] if getattr(e, "response", None) is not None else str(e)
            sb_update("socialbot_posts", {"id": f"eq.{post['id']}"}, {"status": "failed", "error_message": error_msg})
            print(f"FALLO (aprobado por cliente) -> post {post['id']}: {error_msg}")


def run():
    now_utc = datetime.now(timezone.utc)

    # Antes de generar posts nuevos, publicamos los que ya estaban esperando
    # aprobacion del cliente y fueron aprobados desde su portal.
    publish_approved_pending_posts()

    # Y actualizamos las metricas reales (likes/comments/shares/reach) de lo
    # publicado en los ultimos 30 dias -- esto es lo que content_planner.py
    # (Fase 6) usa despues para armar el plan semanal con criterio real.
    try:
        collect_post_metrics()
    except Exception as e:
        print(f"ERROR actualizando metricas de posts (no se corta la corrida): {e}")

    # Los horarios (hour/minute/day_of_week) estan en la hora LOCAL de cada cliente,
    # no en UTC. Por eso no comparamos una unica "hora actual" global: convertimos
    # now_utc al timezone de CADA cliente antes de comparar contra sus slots.
    slots = sb_get("socialbot_schedule_slots", {"active": "eq.true"})
    if not slots:
        print(f"[{now_utc.isoformat()}] No hay horarios activos configurados. Nada que hacer.")
        return

    # Si la corrida viene de un disparo manual con un cliente puntual (por
    # ejemplo, el boton "Publicar ahora" del panel via workflow_dispatch),
    # MANUAL_CLIENT_ID viene seteado y filtramos para procesar solo ESE
    # cliente, no todos los que tengan un horario activo.
    manual_client_id = os.environ.get("MANUAL_CLIENT_ID") or None
    if manual_client_id:
        slots = [s for s in slots if s["client_id"] == manual_client_id]
        if not slots:
            print(f"Cliente {manual_client_id} no tiene horarios activos configurados. Nada que hacer.")
            return

    clients_by_id = {}
    for client_id in {s["client_id"] for s in slots}:
        rows = sb_get("socialbot_clients", {"id": f"eq.{client_id}"})
        if rows:
            clients_by_id[client_id] = rows[0]

    es_corrida_automatica = os.environ.get("GITHUB_EVENT_NAME") == "schedule"

    matching = []  # lista de (client_id, slot) -- un cliente puede tener mas de un horario por dia
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

        if not es_corrida_automatica:
            # Corrida manual (workflow_dispatch o local): un humano la disparo
            # a proposito, asi que no restringimos por dia de la semana ni por
            # franja horaria -- se procesan todos los horarios activos del
            # cliente, sin importar que hora sea ahora.
            matching.append((slot["client_id"], slot))
            continue

        # day_of_week: 1=Lunes..7=Domingo (ISO). NULL = aplica todos los dias.
        if slot.get("day_of_week") is not None and slot["day_of_week"] != local_now.isoweekday():
            continue

        # Tolerancia de +/- 30 min por si el cron no cae exactamente justo
        # (GitHub Actions puede demorar el disparo del cron varios minutos en horas pico)
        slot_minutes = slot["hour"] * 60 + slot["minute"]
        now_minutes = local_now.hour * 60 + local_now.minute
        if abs(slot_minutes - now_minutes) <= 30:
            matching.append((slot["client_id"], slot))

    if not matching:
        print(f"[{now_utc.isoformat()}] Ningun horario coincide con la hora local de algun cliente. Nada que hacer.")
        return

    print(f"Procesando {len(matching)} horario(s) para esta corrida...")

    for client_id, slot in matching:
        try:
            process_client(client_id, slot)
        except Exception as e:
            print(f"ERROR procesando cliente {client_id} (slot {slot['id']}): {e}")


def process_client(client_id, slot):
    clients = sb_get("socialbot_clients", {"id": f"eq.{client_id}", "active": "eq.true"})
    if not clients:
        print(f"Cliente {client_id} inactivo o no encontrado, se salta.")
        return
    client = clients[0]

    # GitHub Actions define automaticamente GITHUB_EVENT_NAME segun como se
    # disparo la corrida: "schedule" = cron automatico, "workflow_dispatch" =
    # alguien lo apreto a mano desde la pestaña Actions. Si se corre local
    # (como "python scheduler/post_scheduler.py" en tu maquina) esta variable
    # no existe, y tambien lo tratamos como manual.
    #
    # El chequeo anti-duplicado de abajo (que evita generar 2 veces el mismo
    # horario del dia) SOLO tiene sentido para el cron automatico -- si sos
    # vos ejecutandolo a mano, es porque QUERES forzar una publicacion de
    # nuevo (por ejemplo, para reintentar despues de arreglar un permiso), asi
    # que en ese caso lo dejamos pasar siempre, sin restriccion.
    es_corrida_automatica = os.environ.get("GITHUB_EVENT_NAME") == "schedule"

    if es_corrida_automatica:
        # Evita duplicar posts si el scheduler corre mas de una vez dentro de la
        # misma ventana horaria de UN MISMO horario (por ejemplo, si el cron
        # reintenta). Ojo: un cliente puede tener varios horarios distintos en
        # el dia (ej: 9am y 6pm) y cada uno debe poder generar su propio post --
        # por eso NO alcanza con "ya hubo un post hoy", hay que fijarse
        # puntualmente si ya hubo uno CERCA DE ESTE horario.
        tz_name = client.get("timezone") or "America/Sao_Paulo"
        try:
            client_tz = ZoneInfo(tz_name)
        except Exception:
            client_tz = ZoneInfo("America/Sao_Paulo")
        local_now = datetime.now(timezone.utc).astimezone(client_tz)
        local_midnight = local_now.replace(hour=0, minute=0, second=0, microsecond=0)
        day_start_utc = local_midnight.astimezone(timezone.utc).isoformat()
        today_posts = sb_get(
            "socialbot_posts",
            {"client_id": f"eq.{client_id}", "scheduled_at": f"gte.{day_start_utc}"},
        )
        slot_minutes = slot["hour"] * 60 + slot["minute"]
        for p in today_posts or []:
            try:
                p_local = datetime.fromisoformat(p["scheduled_at"].replace("Z", "+00:00")).astimezone(client_tz)
            except Exception:
                continue
            p_minutes = p_local.hour * 60 + p_local.minute
            if abs(p_minutes - slot_minutes) <= 30:
                print(
                    f"Cliente {client['name']}: ya se genero un post para el horario "
                    f"{slot['hour']:02d}:{slot['minute']:02d} hoy (id {p['id']}), se salta para no duplicar."
                )
                return
    else:
        print(f"Cliente {client['name']}: corrida manual (workflow_dispatch o local), sin chequeo anti-duplicado.")

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

    carousel_urls = None
    if media and media_type == "carousel":
        carousel_urls = get_carousel_urls(media["id"])
        if len(carousel_urls) < 2:
            print(f"Cliente {client['name']}: el carrusel elegido tiene menos de 2 imagenes cargadas, se salta esta corrida.")
            return

    # FASE 6: si hay un item del plan semanal ya aprobado por la agencia
    # para el dia de hoy, tiene prioridad absoluta -- es contenido revisado
    # a mano, con criterio de performance real, asi que ni el caption fijo
    # del cliente, ni el caption_override del media, ni la IA lo pisan. Si no
    # hay plan aprobado para hoy, seguimos con la logica de prioridad:
    # cliente (caption + hashtags fijos) > agencia (caption_override del
    # medio + sus hashtags) > IA genera todo en el momento.
    plan_item = get_approved_plan_item_for_today(client_id)
    if plan_item:
        caption = plan_item["caption"]
        # FASE 6.1: los hashtags del item (generados por la IA junto con el
        # caption, y editables por la agencia antes de aprobar) no venian
        # adentro del caption -- se guardaban aparte y nunca se usaban al
        # publicar. Ahora se suman al final, en su propio parrafo.
        if plan_item.get("hashtags"):
            caption = f"{caption}\n\n{plan_item['hashtags'].strip()}"
        print(f"Cliente {client['name']}: usando item del plan semanal aprobado para hoy (angulo: {plan_item.get('angle') or '—'}).")
    elif ai_settings.get("client_fixed_caption"):
        # El cliente cargo su propio caption fijo desde su portal -- tiene
        # prioridad sobre el caption_override de la agencia y sobre la IA.
        caption = ai_settings["client_fixed_caption"]
        if ai_settings.get("client_hashtags"):
            caption = f"{caption}\n\n{ai_settings['client_hashtags'].strip()}"
    elif media and media.get("caption_override"):
        # Si el media tiene un caption_override cargado (texto fijo escrito a
        # mano por la agencia), lo usamos tal cual y NO llamamos a la IA.
        caption = media["caption_override"]
        if media.get("hashtags_override"):
            caption = f"{caption}\n\n{media['hashtags_override'].strip()}"
    else:
        # Si no, generamos un caption nuevo automaticamente como antes.
        caption = generate_caption(ai_settings, client["name"], client.get("sales_link"))

    # Si el cliente tiene aprobacion manual activada, el post se genera y se
    # guarda esperando su decision (y puede editar el texto desde su portal),
    # pero NO se publica en este momento. publish_approved_pending_posts() se
    # encarga de publicarlo mas adelante, en la corrida en la que ya este
    # aprobado.
    # Si esta corrida es manual (boton "Publicar ahora" o workflow_dispatch a
    # mano), quien la dispara ya esta dando la orden directa de publicar --
    # no tiene sentido pedirle aprobacion al cliente para algo que la agencia
    # ya decidio ahora mismo. El require_approval del cliente solo aplica en
    # la corrida automatica (cron), que es la que publica sin supervision.
    es_corrida_automatica = os.environ.get("GITHUB_EVENT_NAME") == "schedule"
    require_approval = client.get("require_approval", False) and es_corrida_automatica
    if client.get("require_approval", False) and not es_corrida_automatica:
        print(f"Cliente {client['name']}: tiene aprobacion manual activada, pero esta corrida es manual -> se publica directo, sin pedir aprobacion.")

    created_post_ids = []

    # ---------------------------------------------------------------------------
    # Serialización por plataforma para evitar 429 en Hostinger con videos.
    # Cuando un cliente tiene Facebook + Instagram conectados, ambos crawlers
    # de Meta le piden el video a Hostinger casi al mismo tiempo, y el hosting
    # compartido responde 429 al segundo pedido. La solución es publicar en un
    # orden fijo: Instagram primero (ya incluye su propio polling hasta que Meta
    # termine de procesar el video), y recién cuando termina, Facebook.
    # Así Hostinger solo recibe una descarga de video a la vez por cliente.
    # Para imágenes y carruseles no hay riesgo real de 429 (son requests muy
    # rápidas), pero aplicamos el mismo orden igualmente por consistencia.
    # ---------------------------------------------------------------------------
    def platform_order(account):
        return 0 if account["platform"] == "instagram" else 1

    accounts_ordered = sorted(accounts, key=platform_order)

    for account in accounts_ordered:
        location_id = media.get("location_id_override") if media else None

        post_row = {
            "client_id": client_id,
            "social_account_id": account["id"],
            "platform": account["platform"],
            "caption": caption,
            "media_url": media_url,
            "media_asset_id": media["id"] if media else None,
            "media_type": media_type,
            "status": "pending" if require_approval else "publishing",
            "approval_status": "pending" if require_approval else "approved",
            "scheduled_at": datetime.now(timezone.utc).isoformat(),
        }
        created = sb_insert("socialbot_posts", post_row)[0]
        created_post_ids.append(created["id"])

        if require_approval:
            print(f"ESPERA APROBACION -> {client['name']} / {account['platform']} (post {created['id']} generado, sin publicar)")
            continue

        try:
            if account["platform"] == "facebook":
                fb_photo_override = media.get("fb_photo_url") if media else None
                external_id = publish_facebook(
                    account["page_id"],
                    account["page_access_token"],
                    caption,
                    media_url,
                    location_id,
                    media_type or "image",
                    fb_photo_override,
                    carousel_urls,
                )
            else:
                external_id = publish_instagram(
                    account["ig_business_id"],
                    account["page_access_token"],
                    caption,
                    media_url,
                    media_type or "image",
                    location_id,
                    carousel_urls,
                )

            permalink = _build_permalink(account["platform"], external_id, account["page_access_token"])
            sb_update(
                "socialbot_posts",
                {"id": f"eq.{created['id']}"},
                {"status": "published", "published_at": datetime.now(timezone.utc).isoformat(), "external_post_id": external_id, "permalink_url": permalink},
            )
            print(f"OK -> {client['name']} / {account['platform']} / post {external_id}")
            media_published_ok = True

            # Si hay más cuentas por procesar y el media es un video, esperamos
            # antes de arrancar la siguiente plataforma. Instagram ya terminó de
            # bajar el video de Hostinger (el polling de publish_instagram()
            # confirma status FINISHED antes de retornar), así que ahora es
            # seguro que Hostinger libere el rate-limit. 25 segundos da un
            # margen extra (antes eran 15s y a veces no alcanzaba, ver
            # FALLO por FileUrlProcessingError/429 en publish_facebook); no
            # agrega demora perceptible en imágenes (donde el request a
            # Hostinger ya terminó instantáneamente). Esto es solo una
            # mitigación adicional -- el fix real es que publish_facebook()
            # ahora cae al intento 2 (descarga propia) ante un 429, en vez
            # de abortar el post.
            remaining = accounts_ordered[accounts_ordered.index(account) + 1:]
            if remaining and media_type == "video":
                print(f"Esperando 25 s antes de publicar en la siguiente plataforma para no saturar Hostinger...")
                time.sleep(25)

        except Exception as e:
            error_msg = e.response.text[:500] if getattr(e, "response", None) is not None else str(e)
            sb_update("socialbot_posts", {"id": f"eq.{created['id']}"}, {"status": "failed", "error_message": error_msg})
            print(f"FALLO -> {client['name']} / {account['platform']}: {error_msg}")

    # Si se uso un item del plan semanal, lo marcamos como 'used' y lo
    # linkeamos al primer post generado (references socialbot_posts, on
    # delete set null) -- asi no vuelve a proponerse ni a reusarse, sin
    # importar si termino publicado, en espera de aprobacion, o fallido.
    if plan_item:
        try:
            mark_plan_item_used(plan_item["id"], created_post_ids[0] if created_post_ids else None)
            print(f"Cliente {client['name']}: item del plan semanal (target_date {plan_item['target_date']}) marcado como 'used'.")
        except Exception as e:
            print(f"ERROR marcando como usado el item de plan {plan_item['id']}: {e}")

    # Solo contamos el media como "usado" si se publico de verdad en al menos
    # una cuenta. Si todo fallo (o quedo esperando aprobacion), el media sigue
    # con su times_used original y va a volver a ser el candidato mas
    # prioritario en el proximo intento.
    if media and media_published_ok:
        sb_update("socialbot_media_assets", {"id": f"eq.{media['id']}"}, {"times_used": media["times_used"] + 1})


if __name__ == "__main__":
    run()
