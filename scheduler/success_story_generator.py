"""
success_story_generator.py
---------------------------
Item 6 de PROPUESTAS-AGENCIA.md: caso de éxito / one-pager automático.

A diferencia del resto de scheduler/*.py, este NO corre por cron: es una
herramienta que Fede dispara a mano cuando quiere armar un caso de éxito
para mandarle a un prospecto nuevo. Junta los números reales de un cliente
ya activo (consultas recibidas, clientes convertidos, publicaciones, me
gusta) y arma un one-pager en HTML, listo para abrir en el navegador,
convertir a PDF ("Imprimir > Guardar como PDF") o mandar tal cual.

Uso:
    export SUPABASE_URL=...
    export SUPABASE_SERVICE_KEY=...
    python scheduler/success_story_generator.py <client_id> [--days 90] [--anon]

    --days N     Ventana de métricas a mostrar (default: 90 días).
    --anon       Genera una versión anonimizada ("Cliente del rubro X" en
                 vez del nombre real) para poder mostrársela a otros
                 prospectos sin exponer datos de un cliente puntual.

El archivo sale a scheduler/output/caso-exito-<client_id>.html (se crea la
carpeta si no existe).
"""

import os
import sys
import socket
import argparse
import requests
from datetime import datetime, timezone, timedelta

_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
    return _orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)


socket.getaddrinfo = _ipv4_only_getaddrinfo

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
SUPABASE_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}


def sb_get(table, params):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SUPABASE_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def gather_metrics(client_id, since_iso):
    leads = sb_get(
        "socialbot_leads",
        {"client_id": f"eq.{client_id}", "created_at": f"gte.{since_iso}", "select": "status,created_at"},
    )
    posts = sb_get(
        "socialbot_posts",
        {
            "client_id": f"eq.{client_id}",
            "status": "eq.published",
            "published_at": f"gte.{since_iso}",
            "select": "id,published_at,socialbot_post_metrics(likes)",
        },
    )
    interactions = sb_get(
        "socialbot_interactions_log",
        {"client_id": f"eq.{client_id}", "created_at": f"gte.{since_iso}", "select": "replied,created_at,replied_at"},
    )

    total_leads = len(leads)
    converted = len([l for l in leads if l.get("status") == "convertido"])
    total_posts = len(posts)
    total_likes = sum((p.get("socialbot_post_metrics") or {}).get("likes", 0) or 0 for p in posts)

    replied = [i for i in interactions if i.get("replied")]
    reply_rate = round((len(replied) / len(interactions)) * 100) if interactions else None

    response_minutes = []
    for i in replied:
        if i.get("created_at") and i.get("replied_at"):
            try:
                created = datetime.fromisoformat(i["created_at"].replace("Z", "+00:00"))
                answered = datetime.fromisoformat(i["replied_at"].replace("Z", "+00:00"))
                response_minutes.append((answered - created).total_seconds() / 60)
            except Exception:
                pass
    avg_response_minutes = round(sum(response_minutes) / len(response_minutes)) if response_minutes else None

    return {
        "total_leads": total_leads,
        "converted": converted,
        "conversion_rate": round((converted / total_leads) * 100) if total_leads else None,
        "total_posts": total_posts,
        "total_likes": total_likes,
        "reply_rate": reply_rate,
        "avg_response_minutes": avg_response_minutes,
    }


def render_html(client_name, days, metrics, anon=False):
    display_name = "un cliente real de la agencia" if anon else client_name

    def stat(value, label, suffix=""):
        if value is None:
            return ""
        return f"""
        <div class="stat">
          <div class="stat-value">{value}{suffix}</div>
          <div class="stat-label">{label}</div>
        </div>"""

    stats_html = "".join([
        stat(metrics["total_leads"], "Consultas recibidas"),
        stat(metrics["converted"], "Clientes nuevos"),
        stat(metrics["conversion_rate"], "Tasa de conversión", "%"),
        stat(metrics["total_posts"], "Publicaciones"),
        stat(metrics["total_likes"], "Me gusta totales"),
        stat(metrics["reply_rate"], "Consultas respondidas automáticamente", "%"),
        stat(metrics["avg_response_minutes"], "Minutos, tiempo de respuesta promedio"),
    ])

    return f"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>Caso de éxito</title>
<style>
  body{{ font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f7f6f3; color:#1a1d23; margin:0; }}
  .sheet{{ max-width:720px; margin:40px auto; background:#fff; border-radius:14px; padding:48px; box-shadow:0 8px 30px rgba(0,0,0,0.08); }}
  h1{{ font-family:'Iowan Old Style','Georgia',serif; font-size:28px; margin:0 0 6px; }}
  .subtitle{{ color:#6b6a66; font-size:15px; margin-bottom:32px; }}
  .stats{{ display:grid; grid-template-columns:repeat(2, 1fr); gap:16px; margin-bottom:32px; }}
  .stat{{ background:#e8efe9; border-radius:10px; padding:18px; text-align:center; }}
  .stat-value{{ font-size:30px; font-weight:700; color:#3d5a4c; line-height:1.1; }}
  .stat-label{{ font-size:12.5px; color:#6b6a66; margin-top:6px; }}
  .footer{{ font-size:13px; color:#6b6a66; border-top:1px solid #e1ddd4; padding-top:16px; margin-top:8px; }}
  @media print {{ body{{ background:#fff; }} .sheet{{ box-shadow:none; margin:0; }} }}
</style>
</head>
<body>
  <div class="sheet">
    <h1>Resultados reales con automatización de redes</h1>
    <div class="subtitle">Últimos {days} días — {display_name}</div>
    <div class="stats">{stats_html}</div>
    <div class="footer">
      Estos números salen de la operación real de esta cuenta: respuesta automática
      a comentarios y DMs, detección de leads listos para comprar, y publicación
      programada de contenido. Se puede armar un plan igual para tu negocio.
    </div>
  </div>
</body>
</html>"""


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("client_id")
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--anon", action="store_true")
    args = parser.parse_args()

    clients = sb_get("socialbot_clients", {"id": f"eq.{args.client_id}", "select": "id,name"})
    if not clients:
        print(f"No se encontró ningún cliente con id {args.client_id}")
        sys.exit(1)
    client = clients[0]

    since_iso = (datetime.now(timezone.utc) - timedelta(days=args.days)).isoformat()
    metrics = gather_metrics(args.client_id, since_iso)
    html = render_html(client["name"], args.days, metrics, anon=args.anon)

    out_dir = os.path.join(os.path.dirname(__file__), "output")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"caso-exito-{args.client_id}.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Listo: {out_path}")
    print(metrics)


if __name__ == "__main__":
    main()
