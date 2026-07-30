"""
success_story_generator.py
---------------------------
Item 6 de PROPUESTAS-AGENCIA.md / Punto 9 de propuestas-30-07-2026.md: caso
de éxito / one-pager automático.

Dos modos de uso:

1) Manual, para un cliente puntual (como siempre funcionó):
    export SUPABASE_URL=...
    export SUPABASE_SERVICE_KEY=...
    python scheduler/success_story_generator.py <client_id> [--days 90] [--anon]

    --days N     Ventana de métricas a mostrar (default: 90 días).
    --anon       Genera una versión anonimizada ("Cliente del rubro X" en
                 vez del nombre real) para poder mostrársela a otros
                 prospectos sin exponer datos de un cliente puntual.

    El archivo sale a scheduler/output/caso-exito-<client_id>.html (se crea
    la carpeta si no existe) -- solo local, no toca Storage ni manda mail.

2) Automático mensual (corrido por .github/workflows/success_stories.yml,
   ver ese archivo para el cron): genera el caso de éxito real (sin --anon,
   la versión anónima sigue siendo a mano cuando hace falta mandarle algo a
   un prospecto sin exponer al cliente real) para TODOS los clientes activos
   (socialbot_clients.active = true):
    python scheduler/success_story_generator.py --all [--days 90]

   Por cada cliente:
   - sube el HTML a Supabase Storage, bucket privado 'success-stories',
     path "<client_id>/caso-exito-<timestamp>.html" (bucket y policy de
     RLS ya aplicados en prod, migración 0031_success_stories.sql);
   - guarda/actualiza la fila en socialbot_success_stories (unique por
     client_id -- solo interesa el último caso de éxito vigente, no
     guardamos historial de versiones viejas);
   - el panel de agencia puede pedir un signed URL fresco para ese path
     (supabase.storage.from('success-stories').createSignedUrl(...)),
     respetando la RLS -- nunca queda un link público dando vueltas.

   Al final manda UN solo mail a la agencia con todos los one-pagers del
   mes adjuntos (mismo criterio de "sin costo, sin API paga" del resto del
   proyecto: SMTP que ya usan las demás notify-*/scheduler/*.py). Si faltan
   las credenciales SMTP, no rompe nada: solo se omite el mail, el archivo
   ya quedó subido a Storage igual.
"""

import os
import sys
import socket
import argparse
import smtplib
import ssl
import requests
from email.message import EmailMessage
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


SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.hostinger.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER")
SMTP_PASS = os.environ.get("SMTP_PASS")
SMTP_FROM = os.environ.get("SMTP_FROM") or SMTP_USER
# Destino de los one-pagers mensuales -- la propia casilla de la agencia,
# no la del cliente. Si no se setea AGENCY_EMAIL como secret aparte, se
# manda a la misma casilla que figura como remitente (SMTP_FROM/SMTP_USER).
AGENCY_EMAIL = os.environ.get("AGENCY_EMAIL") or SMTP_FROM


def sb_get(table, params):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SUPABASE_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def upload_to_storage(client_id, filename, html):
    """Sube el HTML al bucket privado 'success-stories' bajo <client_id>/<filename>.
    Bucket + policy de RLS ya existen en prod (migración 0031_success_stories.sql).
    Devuelve el storage_path guardado."""
    storage_path = f"{client_id}/{filename}"
    upload_headers = {**SUPABASE_HEADERS, "Content-Type": "text/html", "x-upsert": "true"}
    r = requests.put(
        f"{SUPABASE_URL}/storage/v1/object/success-stories/{storage_path}",
        headers=upload_headers,
        data=html.encode("utf-8"),
        timeout=30,
    )
    r.raise_for_status()
    return storage_path


def upsert_success_story_row(client_id, storage_path, days):
    """Guarda/actualiza el registro del último caso de éxito de ese cliente
    (unique por client_id -- no interesa guardar versiones viejas)."""
    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/socialbot_success_stories",
        headers={**SUPABASE_HEADERS, "Prefer": "resolution=merge-duplicates"},
        params={"on_conflict": "client_id"},
        json={
            "client_id": client_id,
            "storage_path": storage_path,
            "days": days,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        },
        timeout=30,
    )
    r.raise_for_status()


def send_monthly_email(attachments):
    """attachments: lista de (client_name, filename, html_bytes). Un solo
    mail con todos los one-pagers del mes adjuntos. Si faltan credenciales
    SMTP, se omite sin romper nada (mismo criterio que el resto del repo)."""
    if not SMTP_USER or not SMTP_PASS:
        print("[success_story_generator] SMTP_USER/SMTP_PASS no configurados, se omite el mail mensual.")
        return
    if not attachments:
        print("[success_story_generator] No hay casos de éxito para mandar este mes, se omite el mail.")
        return

    msg = EmailMessage()
    msg["From"] = SMTP_FROM
    msg["To"] = AGENCY_EMAIL
    msg["Subject"] = f"📊 Casos de éxito del mes ({len(attachments)} clientes) — listos para prospectos"
    nombres = "\n".join(f"- {name}" for name, _, _ in attachments)
    msg.set_content(
        "Hola!\n\n"
        f"Se generaron {len(attachments)} casos de éxito actualizados este mes:\n\n"
        f"{nombres}\n\n"
        "Cada uno va adjunto como HTML (abrilo en el navegador y 'Imprimir > Guardar "
        "como PDF' si preferís mandarlo así). También quedaron guardados en el panel "
        "de agencia, pestaña de clientes, por si preferís bajarlos de ahí.\n\n"
        "Recordá: estas versiones tienen el nombre real del cliente. Si vas a "
        "mostrárselo a otro prospecto sin exponer a ese cliente puntual, generá la "
        "versión --anon a mano para ese caso.\n"
    )
    for name, filename, html_bytes in attachments:
        msg.add_attachment(html_bytes, maintype="text", subtype="html", filename=filename)

    ctx = ssl.create_default_context()
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=30) as server:
        server.login(SMTP_USER, SMTP_PASS)
        server.send_message(msg)
    print(f"[success_story_generator] Mail mensual enviado a {AGENCY_EMAIL} con {len(attachments)} adjuntos.")


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


def build_one_pager(client_id, client_name, days, anon):
    since_iso = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    metrics = gather_metrics(client_id, since_iso)
    html = render_html(client_name, days, metrics, anon=anon)
    return html, metrics


def run_manual(client_id, days, anon):
    clients = sb_get("socialbot_clients", {"id": f"eq.{client_id}", "select": "id,name"})
    if not clients:
        print(f"No se encontró ningún cliente con id {client_id}")
        sys.exit(1)
    client = clients[0]

    html, metrics = build_one_pager(client_id, client["name"], days, anon)

    out_dir = os.path.join(os.path.dirname(__file__), "output")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"caso-exito-{client_id}.html")
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)

    print(f"Listo: {out_path}")
    print(metrics)


def run_all(days):
    """Modo automático mensual: un one-pager real (sin --anon) por cada
    cliente activo, subido a Storage + registrado en la tabla + un solo
    mail consolidado con todos los adjuntos al final."""
    clients = sb_get("socialbot_clients", {"active": "eq.true", "select": "id,name"})
    if not clients:
        print("No hay clientes activos, no se genera nada este mes.")
        return

    today_tag = datetime.now(timezone.utc).strftime("%Y-%m")
    attachments = []

    for client in clients:
        client_id, client_name = client["id"], client["name"]
        try:
            html, metrics = build_one_pager(client_id, client_name, days, anon=False)
            if not metrics["total_posts"] and not metrics["total_leads"]:
                print(f"[{client_name}] sin actividad en los últimos {days} días, se omite este mes.")
                continue

            filename = f"caso-exito-{today_tag}.html"
            storage_path = upload_to_storage(client_id, filename, html)
            upsert_success_story_row(client_id, storage_path, days)
            attachments.append((client_name, f"caso-exito-{client_name}-{today_tag}.html", html.encode("utf-8")))
            print(f"[{client_name}] ok -> success-stories/{storage_path}")
        except Exception as e:
            print(f"[{client_name}] ERROR generando/subiendo el caso de éxito: {e}")

    send_monthly_email(attachments)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("client_id", nargs="?", help="Requerido salvo que se use --all")
    parser.add_argument("--all", action="store_true", help="Modo automático mensual: todos los clientes activos")
    parser.add_argument("--days", type=int, default=90)
    parser.add_argument("--anon", action="store_true")
    args = parser.parse_args()

    if args.all:
        run_all(args.days)
    else:
        if not args.client_id:
            parser.error("falta client_id (o usá --all para correr todos los clientes activos)")
        run_manual(args.client_id, args.days, args.anon)


if __name__ == "__main__":
    main()
