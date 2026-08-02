"""
monthly_report.py
------------------
Item 3 de PROPUESTAS-AGENCIA.md ("Reporte mensual automático por cliente").

Se ejecuta 1 vez al mes (via GitHub Actions cron, ver
.github/workflows/monthly_report.yml) y para cada cliente activo con
client_email cargado (portal habilitado), arma un resumen del mes recien
cerrado -- consultas recibidas, clientes nuevos (leads convertidos), me
gusta, alcance real, reproducciones de Reels (si publico alguno),
crecimiento de seguidores del mes, y engagement real/interaccion de
pagina de Facebook si Meta ya tiene esos datos disponibles -- y se lo
manda por email. Mismos numeros que renderMetrics() calcula en
frontend/cliente/Cliente.html, pero mandados solos sin que el cliente
tenga que entrar a mirarlos, y sin que Fede tenga que armarlo a mano.

Cada dato nuevo (reach, plays, seguidores, engagement) solo aparece en el
mail si efectivamente hay dato disponible para ese cliente en ese mes --
mismo criterio de "null = sin dato todavia, no 0" que ya se usa en todo
el resto del proyecto (post_scheduler.py, metrics.js). Un cliente sin
Reels publicados, por ejemplo, simplemente no ve la linea de
reproducciones, en vez de ver "0".

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
        "reach": lambda n: f"👁️ Alcance real: {n} cuentas",
        "plays": lambda n: f"▶️ Reproducciones en Reels: {n}",
        "watchTime": lambda s: f"⏱️ Duración promedio de vista: {s}s",
        "followers": lambda total, growth: f"📈 Seguidores: {total} ({'+' if growth >= 0 else ''}{growth} en el mes)",
        "engagementRate": lambda pct: f"📊 Engagement real (últimos 28 días): {pct}%",
        "fbEngagement": lambda n: f"📘 Interacción en tu página de Facebook (últimos 28 días): {n}",
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
        "reach": lambda n: f"👁️ Alcance real: {n} contas",
        "plays": lambda n: f"▶️ Reproduções em Reels: {n}",
        "watchTime": lambda s: f"⏱️ Duração média de visualização: {s}s",
        "followers": lambda total, growth: f"📈 Seguidores: {total} ({'+' if growth >= 0 else ''}{growth} no mês)",
        "engagementRate": lambda pct: f"📊 Engajamento real (últimos 28 dias): {pct}%",
        "fbEngagement": lambda n: f"📘 Interação na sua página do Facebook (últimos 28 dias): {n}",
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
            "select": "id,media_type,socialbot_post_metrics(likes,reach,plays,avg_watch_time_ms)",
            "client_id": f"eq.{client_id}",
            "status": "eq.published",
            "and": f"(published_at.gte.{start_iso},published_at.lt.{end_iso})",
        })
        total_posts = len(posts)
        total_likes = 0
        total_reach = 0
        posts_with_reach = 0
        total_plays = 0
        posts_with_plays = 0
        watch_time_sum_ms = 0
        posts_with_watch_time = 0
        for p in posts:
            metrics = p.get("socialbot_post_metrics") or []
            if isinstance(metrics, dict):
                metrics = [metrics]
            for m in metrics:
                m = m or {}
                total_likes += m.get("likes") or 0
                # Mismo criterio que renderMetrics() en metrics.js: reach/plays
                # en null significa "todavia no tenemos el dato", no "0" -- se
                # cuenta aparte cuantos posts SI tienen el dato para no mostrar
                # un numero mas bajo del real si Meta todavia no lo calculo.
                if m.get("reach") is not None:
                    total_reach += m["reach"]
                    posts_with_reach += 1
                if m.get("plays") is not None:
                    total_plays += m["plays"]
                    posts_with_plays += 1
                if m.get("avg_watch_time_ms") is not None:
                    watch_time_sum_ms += m["avg_watch_time_ms"]
                    posts_with_watch_time += 1
        avg_watch_time_seconds = round(watch_time_sum_ms / posts_with_watch_time / 1000) if posts_with_watch_time else None

        # Crecimiento de seguidores durante el mes: primer y ultimo snapshot
        # diario dentro del rango, sumado entre todas las cuentas del cliente
        # (mismo enfoque que followerCards en metrics.js, pero acotado al mes
        # del reporte en vez de "ultimos 7 dias").
        start_date_iso, end_date_iso = start.date().isoformat(), end.date().isoformat()
        snapshots = sb_get("socialbot_follower_snapshots", {
            "select": "social_account_id,follower_count,snapshot_date,socialbot_social_accounts!inner(platform,client_id)",
            "socialbot_social_accounts.client_id": f"eq.{client_id}",
            "and": f"(snapshot_date.gte.{start_date_iso},snapshot_date.lt.{end_date_iso})",
            "order": "snapshot_date.asc",
        })
        first_by_account, last_by_account = {}, {}
        for s in snapshots:
            acc_id = s["social_account_id"]
            if acc_id not in first_by_account:
                first_by_account[acc_id] = s["follower_count"]
            last_by_account[acc_id] = s["follower_count"]
        follower_growth = sum(last_by_account[a] - first_by_account[a] for a in last_by_account)
        has_growth_data = bool(last_by_account)
        total_followers = sum(last_by_account.values()) if has_growth_data else None

        # Alcance de audiencia (seguidor/no-seguidor) + accounts_engaged de
        # Instagram, y page_engagement de Facebook -- son snapshots de "ultimos
        # 28 dias" al momento en que corrio el collector, no acotados
        # exactamente al mes del reporte (igual que en el panel en vivo).
        ig_accounts = sb_get("socialbot_social_accounts", {
            "select": "platform,socialbot_audience_reach(follower_reach,non_follower_reach,accounts_engaged)",
            "client_id": f"eq.{client_id}",
            "platform": "eq.instagram",
        })
        follower_reach = non_follower_reach = accounts_engaged = 0
        has_engagement_data = False
        for acc in ig_accounts:
            row = acc.get("socialbot_audience_reach")
            row = row[0] if isinstance(row, list) and row else (row if isinstance(row, dict) else None)
            if row and row.get("accounts_engaged") is not None and (row.get("follower_reach") or row.get("non_follower_reach")):
                has_engagement_data = True
                follower_reach += row.get("follower_reach") or 0
                non_follower_reach += row.get("non_follower_reach") or 0
                accounts_engaged += row["accounts_engaged"]
        engagement_rate = round(accounts_engaged / (follower_reach + non_follower_reach) * 100) if has_engagement_data and (follower_reach + non_follower_reach) else None

        fb_accounts = sb_get("socialbot_social_accounts", {
            "select": "platform,socialbot_audience_reach(page_engagement)",
            "client_id": f"eq.{client_id}",
            "platform": "eq.facebook",
        })
        fb_page_engagement = 0
        has_fb_engagement_data = False
        for acc in fb_accounts:
            row = acc.get("socialbot_audience_reach")
            row = row[0] if isinstance(row, list) and row else (row if isinstance(row, dict) else None)
            if row and row.get("page_engagement") is not None:
                has_fb_engagement_data = True
                fb_page_engagement += row["page_engagement"]

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
            texts["likes"](total_likes),
        ]
        if posts_with_reach:
            lines.append(texts["reach"](total_reach))
        if posts_with_plays:
            lines.append(texts["plays"](total_plays))
        if avg_watch_time_seconds is not None:
            lines.append(texts["watchTime"](avg_watch_time_seconds))
        if has_growth_data:
            lines.append(texts["followers"](total_followers, follower_growth))
        if engagement_rate is not None:
            lines.append(texts["engagementRate"](engagement_rate))
        if has_fb_engagement_data:
            lines.append(texts["fbEngagement"](fb_page_engagement))
        lines.append("")
        if CLIENT_PORTAL_URL:
            lines += [texts["portal"] + CLIENT_PORTAL_URL, ""]
        lines.append(texts["closing"])

        send_email(email, texts["subject"](month_label), "\n".join(lines))


if __name__ == "__main__":
    main()
