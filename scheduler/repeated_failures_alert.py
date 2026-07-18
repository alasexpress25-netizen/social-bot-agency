"""
repeated_failures_alert.py
---------------------------
Item 15 de PROPUESTAS-AGENCIA.md ("Alertas de fallos recurrentes").

Se ejecuta periodicamente (via GitHub Actions cron, ver
.github/workflows/repeated_failures_alert.yml). Para cada cliente activo,
mira sus ultimos REPEATED_FAILURES_THRESHOLD posts (por created_at desc): si
TODOS son status='failed' y el mas reciente de esa racha ocurrio dentro de
REPEATED_FAILURES_HOURS, lo marca "con fallos recurrentes" y arma un unico
email a la agencia (al owner de cada socialbot_agencies) con la lista de
clientes en esa situacion -- mismo patron que inactive_clients_alert.py.

El caso tipico que motiva esto: una cuenta con el token vencido, o (como paso
con Instagram/video) una limitacion de la API que hace fallar reintento tras
reintento sin que nadie se entere hasta entrar al panel.

Nota sobre duplicados: este script NO lleva un registro de "ya avisado" (a
diferencia de remind-pending-post, que si tiene esa columna). Si la racha de
fallos sigue sin resolverse, va a volver a avisar en cada corrida dentro de
la ventana de REPEATED_FAILURES_HOURS. Se considera aceptable para un primer
corte (mejor pecar de insistente en un problema real que ser silencioso) --
si en la practica resulta ruidoso, la solucion mas simple es correrlo con
menos frecuencia (el cron sugerido es 1 vez por dia) o sumarle una columna
tipo `repeated_failure_alert_sent_at` en socialbot_clients mas adelante.
"""

import os
import smtplib
import ssl
from email.mime.text import MIMEText
from datetime import datetime, timezone, timedelta

import requests

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

SMTP_HOST = os.environ.get("SMTP_HOST", "smtp.hostinger.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "465"))
SMTP_USER = os.environ.get("SMTP_USER")
SMTP_PASS = os.environ.get("SMTP_PASS")
SMTP_FROM = os.environ.get("SMTP_FROM") or SMTP_USER

REPEATED_FAILURES_THRESHOLD = int(os.environ.get("REPEATED_FAILURES_THRESHOLD", "3"))
REPEATED_FAILURES_HOURS = int(os.environ.get("REPEATED_FAILURES_HOURS", "48"))

SUPABASE_HEADERS = {
    "apikey": SUPABASE_SERVICE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
    "Content-Type": "application/json",
}


def sb_get(table, params):
    r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", headers=SUPABASE_HEADERS, params=params, timeout=30)
    r.raise_for_status()
    return r.json()


def get_auth_user_email(user_id):
    r = requests.get(
        f"{SUPABASE_URL}/auth/v1/admin/users/{user_id}",
        headers=SUPABASE_HEADERS,
        timeout=30,
    )
    if r.status_code != 200:
        return None
    return r.json().get("email")


def send_email(to_email, subject, body):
    if not SMTP_USER or not SMTP_PASS:
        print(f"[repeated_failures_alert] SMTP_USER/SMTP_PASS no configurados, se omite email a {to_email}.")
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
        print(f"[repeated_failures_alert] Email enviado a {to_email}.")
    except Exception as e:
        print(f"[repeated_failures_alert] Error mandando email a {to_email}: {e}")


def main():
    now = datetime.now(timezone.utc)
    window_cutoff_iso = (now - timedelta(hours=REPEATED_FAILURES_HOURS)).isoformat()

    clients = sb_get("socialbot_clients", {
        "select": "id,name,agency_id",
        "active": "eq.true",
    })
    print(f"[repeated_failures_alert] {len(clients)} clientes activos. "
          f"Umbral: {REPEATED_FAILURES_THRESHOLD} fallos seguidos dentro de {REPEATED_FAILURES_HOURS}hs.")

    flagged_by_agency = {}

    for c in clients:
        client_id = c["id"]
        recent = sb_get("socialbot_posts", {
            "select": "id,status,created_at,error_message,socialbot_social_accounts(platform)",
            "client_id": f"eq.{client_id}",
            "order": "created_at.desc",
            "limit": str(REPEATED_FAILURES_THRESHOLD),
        })

        if len(recent) < REPEATED_FAILURES_THRESHOLD:
            continue  # todavia no tiene historial suficiente para hablar de "racha"

        all_failed = all(p["status"] == "failed" for p in recent)
        most_recent_at = recent[0]["created_at"]
        within_window = most_recent_at and most_recent_at >= window_cutoff_iso

        if all_failed and within_window:
            flagged_by_agency.setdefault(c["agency_id"], []).append({
                "name": c["name"],
                "count": len(recent),
                "last_error": (recent[0].get("error_message") or "")[:200],
                "last_platform": (recent[0].get("socialbot_social_accounts") or {}).get("platform") or "?",
                "last_at": most_recent_at,
            })

    if not flagged_by_agency:
        print("[repeated_failures_alert] Ningun cliente con fallos recurrentes esta corrida.")
        return

    for agency_id, flagged_clients in flagged_by_agency.items():
        agency = sb_get("socialbot_agencies", {"select": "id,name,owner_user_id", "id": f"eq.{agency_id}"})
        if not agency:
            continue
        owner_email = get_auth_user_email(agency[0]["owner_user_id"])
        if not owner_email:
            print(f"[repeated_failures_alert] No se encontro email del owner de la agencia {agency_id}.")
            continue

        lines = [
            f"Tenés {len(flagged_clients)} cliente(s) con {REPEATED_FAILURES_THRESHOLD}+ publicaciones",
            "seguidas fallidas (puede ser un token vencido u otro problema de fondo):", "",
        ]
        for cli in flagged_clients:
            last_at_txt = cli["last_at"][:16].replace("T", " ") if cli["last_at"] else "?"
            lines.append(f"- {cli['name']} ({cli['last_platform']}): último intento {last_at_txt}")
            if cli["last_error"]:
                lines.append(f"    último error: {cli['last_error']}")
        lines += ["", "Conviene revisar la conexión de esas cuentas antes de que se acumulen más fallos."]

        send_email(
            owner_email,
            f"🚨 {len(flagged_clients)} cliente(s) con fallos de publicación recurrentes",
            "\n".join(lines),
        )


if __name__ == "__main__":
    main()
