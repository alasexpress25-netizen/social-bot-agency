"""
monthly_report.py
------------------
Item 3 de PROPUESTAS-AGENCIA.md ("Reporte mensual automático por cliente").

Se ejecuta 1 vez al mes (via GitHub Actions cron, ver
.github/workflows/monthly_report.yml) y para cada cliente activo con
client_email cargado (portal habilitado), arma un resumen del mes recien
cerrado -- consultas recibidas, clientes nuevos (leads convertidos) y me
gusta en publicaciones -- y se lo manda por email. Mismos numeros que
renderMetrics() calcula en frontend/cliente.html, pero mandados solos sin
que el cliente tenga que entrar a mirarlos, y sin que Fede tenga que
armarlo a mano.

Sigue el mismo estilo que post_scheduler.py / content_planner.py: REST
directo contra Supabase (sin SDK) con la service_role key, sin agregar
dependencias nuevas (smtplib es de la libreria estandar de Python).

Si no hay credenciales SMTP cargadas como GitHub Secret, no rompe nada:
loguea y sigue (mismo criterio de "fallback silencioso" que
notify-pending-post en supabase/functions).
"""

import os
import smtplib
import ssl
from email.mime.text import MIMEText
from datetime import datetime, timezone

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.hostinger.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER")
SMTP_PASS = os.environ.get("SMTP_PASS")
SMTP_FROM = os.environ.get("SMTP_FROM") or SMTP_USER
CLIENT_PORTAL_URL = os.environ.get("CLIENT_PORTAL_URL", "")

SUPABASE_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}


def sb_get(table, params):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SUPABASE_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def previous_month_range(now=None):
    """Devuelve (inicio, fin) en UTC del mes calendario anterior al actual."""
    now = now or datetime.now(timezone.utc)
    first_of_this_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    end = first_of_this_month
    if first_of_this_month.month == 1:
        prev_month, prev_year = 12, first_of_this_month.year - 1
    else:
        prev_month, prev_year = first_of_this_month.month - 1, first_of_this_month.year
    start = first_of_this_month.replace(year=prev_year, month=prev_month, day=1)
    return start, end


TEXTS = {
    "es": {
        "subject": lambda month_label: f"Tu resumen de {month_label}",
        "greeting": "¡Hola!",
        "intro": lambda month_label: f"Este es el resumen de tu cuenta durante {month_label}:",
        "leads": lambda n: f"📩 Consultas recibidas: {n}",
        "converted": lambda n: f"🤝 Clientes nuevos (convertidos): {n}",
        "likes": lambda n: f"❤️ Me gusta en tus publicaciones: {n}",
        "posts": lambda n: f"📅 Publicaciones realizadas: {n}",
        "portal": "Podés ver el detalle completo, con gráficos, en tu panel: ",
        "closing": "Gracias por confiar en nosotros.",
    },
    "pt-BR": {
        "subject": lambda month_label: f"Seu resumo de {month_label}",
        "greeting": "Olá!",
        "intro": lambda month_label: f"Este é o resumo da sua conta durante {month_label}:",
        "leads": lambda n: f"📩 Consultas recebidas: {n}",
        "converted": lambda n: f"🤝 Clientes novos (convertidos): {n}",
        "likes": lambda n: f"❤️ Curtidas nas suas publicações: {n}",
        "posts": lambda n: f"📅 Publicações feitas: {n}",
        "portal": "Você pode ver o detalhe completo, com gráficos, no seu painel: ",
        "closing": "Obrigado por confiar em nós.",
    },
}

MONTH_LABELS = {
    "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
           "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    "pt-BR": ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho",
              "agosto", "setembro", "outubro", "novembro", "dezembro"],
}


def send_email(to_email, subject, body):
    if not SMTP_USER or not SMTP_PASS:
        print(f"[monthly_report] SMTP_USER/SMTP_PASS no configurados, se omite email a {to_email}.")
        return
    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = subject
    msg["From"] = SMTP_FROM
    msg["To"] = to_email
    try:
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=ctx, timeout=30) as server:
            server.login(SMTP_USER, SMTP_PASS)
            server.sendmail(SMTP_FROM, [to_email], msg.as_string())
        print(f"[monthly_report] Email enviado a {to_email}.")
    except Exception as e:
        print(f"[monthly_report] Error mandando email a {to_email}: {e}")


def main():
    start, end = previous_month_range()
    start_iso, end_iso = start.isoformat(), end.isoformat()

    clients = sb_get("socialbot_clients", {
        "select": "id,name,client_email",
        "active": "eq.true",
        "client_email": "not.is.null",
    })
    print(f"[monthly_report] {len(clients)} clientes con portal activo. Periodo: {start_iso} a {end_iso}")

    for c in clients:
        client_id = c["id"]
        email = c["client_email"]
        if not email:
            continue

        # Nota: PostgREST no acepta dos filtros "created_at" como keys
        # separadas de un mismo dict de params (la segunda pisaria a la
        # primera) -- se combina el rango con el operador "and" en su lugar.
        leads = sb_get("socialbot_leads", {
            "select": "status",
            "client_id": f"eq.{client_id}",
            "and": f"(created_at.gte.{start_iso},created_at.lt.{end_iso})",
        })
        total_leads = len(leads)
        total_converted = sum(1 for l in leads if l.get("status") == "convertido")

        posts = sb_get("socialbot_posts", {
            "select": "id,socialbot_post_metrics(likes)",
            "client_id": f"eq.{client_id}",
            "status": "eq.published",
            "and": f"(published_at.gte.{start_iso},published_at.lt.{end_iso})",
        })
        total_posts = len(posts)
        total_likes = 0
        for p in posts:
            metrics = p.get("socialbot_post_metrics") or []
            if isinstance(metrics, dict):
                metrics = [metrics]
            for m in metrics:
                total_likes += (m or {}).get("likes") or 0

        ai_settings = sb_get("socialbot_ai_settings", {
            "select": "reply_language",
            "client_id": f"eq.{client_id}",
        })
        lang = "pt-BR"
        if ai_settings and ai_settings[0].get("reply_language") in ("es", "pt-BR"):
            lang = ai_settings[0]["reply_language"]
        elif ai_settings and ai_settings[0].get("reply_language") == "auto":
            lang = "pt-BR"

        texts = TEXTS[lang]
        month_label = MONTH_LABELS[lang][start.month - 1] + f" {start.year}"

        lines = [
            texts["greeting"], "",
            texts["intro"](month_label), "",
            texts["leads"](total_leads),
            texts["converted"](total_converted),
            texts["posts"](total_posts),
            texts["likes"](total_likes), "",
        ]
        if CLIENT_PORTAL_URL:
            lines += [texts["portal"] + CLIENT_PORTAL_URL, ""]
        lines.append(texts["closing"])

        send_email(email, texts["subject"](month_label), "\n".join(lines))


if __name__ == "__main__":
    main()
