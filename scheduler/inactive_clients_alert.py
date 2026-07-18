"""
inactive_clients_alert.py
--------------------------
Item 4 de PROPUESTAS-AGENCIA.md ("Alerta de cliente en riesgo (inactividad)").

Se ejecuta 1 vez por semana (via GitHub Actions cron, ver
.github/workflows/inactive_clients_alert.yml). Para cada cliente activo,
mira su ultimo post PUBLICADO y su ultimo lead recibido; si ambos estan mas
viejos que INACTIVITY_DAYS (o directamente no existen), lo marca "en
riesgo" y arma un unico email a la agencia (al owner de cada
socialbot_agencies) con la lista de clientes en esa situacion, para que
Fede pueda escribirles antes de que el cliente se queje o se de de baja.

Mismo estilo que post_scheduler.py / content_planner.py: REST directo
contra Supabase con la service_role key, sin SDK. Para el email del owner
de la agencia se usa el endpoint admin de Supabase Auth (GoTrue), porque
esa tabla (auth.users) no esta expuesta via PostgREST.
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

INACTIVITY_DAYS = int(os.environ.get("INACTIVITY_DAYS", "14"))

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
        print(f"[inactive_clients_alert] SMTP_USER/SMTP_PASS no configurados, se omite email a {to_email}.")
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
        print(f"[inactive_clients_alert] Email enviado a {to_email}.")
    except Exception as e:
        print(f"[inactive_clients_alert] Error mandando email a {to_email}: {e}")


def main():
    cutoff = datetime.now(timezone.utc) - timedelta(days=INACTIVITY_DAYS)
    cutoff_iso = cutoff.isoformat()

    clients = sb_get("socialbot_clients", {
        "select": "id,name,agency_id",
        "active": "eq.true",
    })
    print(f"[inactive_clients_alert] {len(clients)} clientes activos. Umbral: {INACTIVITY_DAYS} dias sin actividad.")

    at_risk_by_agency = {}

    for c in clients:
        client_id = c["id"]

        last_post = sb_get("socialbot_posts", {
            "select": "published_at",
            "client_id": f"eq.{client_id}",
            "status": "eq.published",
            "order": "published_at.desc",
            "limit": "1",
        })
        last_lead = sb_get("socialbot_leads", {
            "select": "created_at",
            "client_id": f"eq.{client_id}",
            "order": "created_at.desc",
            "limit": "1",
        })

        last_post_at = last_post[0]["published_at"] if last_post else None
        last_lead_at = last_lead[0]["created_at"] if last_lead else None

        post_stale = (last_post_at is None) or (last_post_at < cutoff_iso)
        lead_stale = (last_lead_at is None) or (last_lead_at < cutoff_iso)

        if post_stale and lead_stale:
            at_risk_by_agency.setdefault(c["agency_id"], []).append({
                "name": c["name"],
                "last_post_at": last_post_at,
                "last_lead_at": last_lead_at,
            })

    if not at_risk_by_agency:
        print("[inactive_clients_alert] Ningun cliente en riesgo esta semana.")
        return

    for agency_id, at_risk_clients in at_risk_by_agency.items():
        agency = sb_get("socialbot_agencies", {"select": "id,name,owner_user_id", "id": f"eq.{agency_id}"})
        if not agency:
            continue
        owner_email = get_auth_user_email(agency[0]["owner_user_id"])
        if not owner_email:
            print(f"[inactive_clients_alert] No se encontro email del owner de la agencia {agency_id}.")
            continue

        lines = [
            f"Tenés {len(at_risk_clients)} cliente(s) sin actividad hace {INACTIVITY_DAYS}+ días",
            "(sin publicaciones nuevas ni consultas de leads):", "",
        ]
        for cli in at_risk_clients:
            last_post_txt = cli["last_post_at"][:10] if cli["last_post_at"] else "nunca"
            last_lead_txt = cli["last_lead_at"][:10] if cli["last_lead_at"] else "nunca"
            lines.append(f"- {cli['name']}: último post {last_post_txt} · último lead {last_lead_txt}")
        lines += ["", "Puede valer la pena escribirles antes de que se quejen o se den de baja."]

        send_email(
            owner_email,
            f"⚠️ {len(at_risk_clients)} cliente(s) en riesgo de inactividad",
            "\n".join(lines),
        )


if __name__ == "__main__":
    main()
