"""
sb_common.py
------------
Helpers compartidos entre post_scheduler.py (solo publicacion) y
metrics_collector.py (solo metricas) -- se separaron en un modulo aparte
el 02/08/2026 para no duplicar codigo entre los dos scripts.

Por que se separaron los scripts en primer lugar: post_scheduler.py corria
cada 15 minutos y, ademas de publicar, hacia TODA la recoleccion de
metricas (collect_post_metrics/collect_audience_reach/
collect_facebook_page_engagement/collect_follower_snapshots) antes de
revisar si habia algo para publicar. A medida que crecio la cantidad de
posts/clientes, esa recoleccion empezo a tardar mas de 10 minutos --
atrasando la publicacion real (que si necesita correr cerca del horario
elegido por el cliente). Las metricas, en cambio, no necesitan esa
frecuencia (reach/alcance de 28 dias no cambia de un momento a otro), asi
que pasaron a su propio script con su propio cron, mas espaciado.
"""

import os
import socket

import requests

# ---------------------------------------------------------------------------
# Forzar IPv4 en todas las conexiones salientes.
# ---------------------------------------------------------------------------
# Hostinger (lavisualmk.alastecno.com) resuelve tanto en IPv4 como en IPv6.
# Los runners de GitHub Actions a veces no tienen ruta de salida IPv6
# completa, entonces al intentar conectar por IPv6 primero tira
# "[Errno 101] Network is unreachable" aunque el sitio ande perfecto por
# IPv4. Este parche obliga a que TODO el DNS resuelto por el proceso
# (requests, urllib3, etc.) devuelva solo direcciones IPv4. Va aca (no en
# cada script) para que aplique apenas se importa sb_common, sin tener que
# repetirlo en post_scheduler.py y en metrics_collector.py por separado.
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


def sb_delete(table, match_params):
    """
    Borra filas por match exacto de columnas (ej. {"social_account_id":
    "eq.xxx", "breakdown_type": "eq.gender_age"}). Usado por
    collect_audience_demographics() (metrics_collector.py) para limpiar,
    antes de cada corrida, las claves de un breakdown que ya no vienen en
    la respuesta de Meta (ej. una ciudad que salio del top-45) -- sb_upsert
    solo pisa/agrega filas, nunca borra las que dejaron de aparecer.
    """
    r = requests.delete(
        f"{SUPABASE_URL}/rest/v1/{table}",
        headers=SUPABASE_HEADERS,
        params=match_params,
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
