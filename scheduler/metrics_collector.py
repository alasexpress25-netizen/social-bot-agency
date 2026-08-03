"""
metrics_collector.py
---------------------
Recoleccion de metricas de Meta Graph API, separada de post_scheduler.py
el 02/08/2026 (ver nota en sb_common.py del por que). Corre con su propio
cron (mas espaciado que los 15 minutos de post_scheduler.py -- ver
.github/workflows/metrics_collector.yml) y hace, en orden:

  1. collect_post_metrics(): likes/comments/shares/reach/impressions/saved/
     plays/avg_watch_time_ms de los posts publicados en los ultimos 30 dias
     (socialbot_post_metrics). Es lo que content_planner.py (Fase 6) usa
     despues para saber que angulo/formato funciono mejor con cada cliente.
  2. collect_audience_reach(): alcance de CUENTA (no por post) de cada
     cuenta de Instagram, desglosado en seguidor/no-seguidor +
     profile_views + accounts_engaged de los ultimos 28 dias
     (socialbot_audience_reach). Solo se guarda el ultimo total.
  3. collect_facebook_page_engagement(): engagement total (page_post_
     engagements) de cada Pagina de Facebook, ultimos 28 dias, misma tabla
     que el punto anterior (columna page_engagement).
  4. collect_audience_demographics() (agregado 03/08/2026): snapshot
     demografico de audiencia -- genero+edad, pais y ciudad -- de cada
     cuenta conectada (socialbot_audience_demographics). Instagram trae
     los 3 tipos; Facebook solo pais/ciudad (Meta depreco genero/edad de
     Paginas en 2024 sin dar reemplazo). Solo se guarda el ultimo
     snapshot, no hay historial dia por dia.
  5. collect_follower_snapshots(): snapshot diario de seguidores/fans
     totales de CADA cuenta conectada (Facebook e Instagram), para la
     variacion semanal que se muestra en "Métricas" del panel de agencia.
  6. collect_weekly_client_snapshot(): dashboard consolidado multi-cliente
     (agencia) -- 1 fila por cliente por semana con 7 metricas clave
     (likes, comments, leads, leads_convertidos, clics_link, seguidores,
     reach), para el semaforo de crecimiento por cliente
     (socialbot_client_weekly_snapshots).

No requiere servidor: corre como un job de GitHub Actions y termina. Mismo
criterio best-effort que post_scheduler.py: si una de las funciones falla,
se loguea el error y se sigue con la siguiente (un fallo puntual de Meta
no debe frenar el resto de la recoleccion).
"""

from datetime import datetime, timezone, timedelta

import requests

from sb_common import sb_delete, sb_get, sb_update, sb_upsert, GRAPH_API_VERSION, _clean_external_id

# collect_post_metrics(): despues de esta cantidad de fallos consecutivos
# trayendo metricas de un post (ej. el cliente lo borro, oculto los likes,
# etc.), se deja de reintentar en cada corrida y pasa a reintentarse solo 1
# vez cada RETRY_COOLDOWN_HOURS horas. Ver migracion 0017.
MAX_METRICS_FETCH_FAILURES = 3
RETRY_COOLDOWN_HOURS = 24


def _fetch_facebook_post_insights(post_id, access_token):
    """Reach de un post de Pagina. Best-effort: si Meta no tiene el dato
    todavia (posts muy recientes) o el permiso no alcanza, no rompe nada --
    simplemente esas columnas quedan en null.

    Item 3 de propuestas-30-07-2026.md (30/07/2026): Meta deprecó
    'post_impressions' y 'post_impressions_unique' el 15/06/2026 (quedan
    invalidos para todas las versiones de la API) -- por eso este fetch
    venia devolviendo siempre None,None para Facebook sin ningun error
    visible (el except silencioso se comia el "invalid metric"). El
    reemplazo oficial de Meta es 'post_total_media_view_unique' (alcance
    unico del post); no hay un reemplazo directo para "impressions" totales,
    asi que esa columna queda sin dato por ahora.
    """
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{post_id}/insights",
            params={"metric": "post_total_media_view_unique", "access_token": access_token},
            timeout=30,
        )
        r.raise_for_status()
        values = {d["name"]: d["values"][0]["value"] for d in r.json().get("data", []) if d.get("values")}
        return values.get("post_total_media_view_unique"), None
    except Exception:
        return None, None


def _fetch_instagram_reach_and_saved(media_id, access_token):
    """
    Reach Y guardados de un post de Instagram, en la misma llamada
    (metric=reach,saved) para no duplicar el pedido a la API. 'saved' =
    cuanta gente guardo el posteo -- señal mas fuerte de contenido que vale
    la pena que el like, porque implica intencion de volver a verlo despues.

    Devuelve (reach, saved). Best-effort: si Meta no tiene el dato todavia
    (post muy reciente) o el permiso no alcanza, devuelve (None, None) en
    vez de cortar la corrida.
    """
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{media_id}/insights",
            params={"metric": "reach,saved", "access_token": access_token},
            timeout=30,
        )
        r.raise_for_status()
        values = {}
        for d in r.json().get("data", []):
            if d.get("values"):
                values[d["name"]] = d["values"][0]["value"]
        return values.get("reach"), values.get("saved")
    except Exception:
        return None, None


def _fetch_instagram_audience_reach(ig_business_id, access_token, period="days_28"):
    """
    Alcance de CUENTA (no de un post puntual) desglosado por si la cuenta
    alcanzada sigue o no el perfil -- metrica 'reach' con
    breakdown=follow_type, metric_type=total_value (formato que pide Meta
    para metricas con breakdown desde la v19+ de la Graph API).
    period='days_28' porque Meta ya lo da como ventana movil agregada -- no
    hace falta acumular dia por dia para tener "un total" (ver
    socialbot_audience_reach, que solo guarda el ultimo snapshot).

    Devuelve (follower_reach, non_follower_reach). Best-effort, igual que
    _fetch_instagram_reach_and_saved: si Meta no tiene el dato todavia
    (cuenta sin actividad reciente) o el permiso no alcanza, devuelve
    (None, None) en vez de cortar la corrida.
    """
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_business_id}/insights",
            params={
                "metric": "reach",
                "period": period,
                "metric_type": "total_value",
                "breakdown": "follow_type",
                "access_token": access_token,
            },
            timeout=30,
        )
        r.raise_for_status()
        data = r.json().get("data", [])
        if not data:
            return None, None
        breakdowns = data[0].get("total_value", {}).get("breakdowns", [])
        if not breakdowns:
            return None, None
        results = breakdowns[0].get("results", [])
        by_type = {}
        for item in results:
            dims = item.get("dimension_values") or []
            if dims:
                by_type[dims[0]] = item.get("value")
        return by_type.get("FOLLOWER"), by_type.get("NON_FOLLOWER")
    except Exception:
        return None, None


def _fetch_instagram_account_engagement(ig_business_id, access_token, period="days_28"):
    """
    Dos metricas de CUENTA de Instagram sin breakdown, pedidas en la MISMA
    llamada a /insights para no duplicar requests:

    - 'profile_views': cuanta gente VISITO el perfil (no solo vio un post)
      en la ventana elegida. Señal mas fuerte que el reach: implica que
      alguien se tomo el trabajo de tocar el nombre de usuario para ver el
      perfil completo (bio, link, historial de posts), no solo se cruzo
      con un post en el feed.
    - 'accounts_engaged': cuantas cuentas UNICAS interactuaron (like,
      comment, save, share) con el contenido en la ventana elegida. Sirve
      para calcular un % de engagement real sobre el reach
      (accounts_engaged / reach), en vez de solo sumar likes+comments como
      proxy indirecto.

    Mismo formato que _fetch_instagram_audience_reach (metric_type=
    total_value, que Meta empezo a pedir para metricas de cuenta desde la
    v19+ de la Graph API), pero sin 'breakdown' porque ninguna de las dos
    lo admite.

    Devuelve (profile_views, accounts_engaged), cada uno int o None si Meta
    todavia no tiene el dato (cuenta sin actividad reciente) o el permiso
    no alcanza -- best-effort, no corta la corrida.
    """
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_business_id}/insights",
            params={
                "metric": "profile_views,accounts_engaged",
                "period": period,
                "metric_type": "total_value",
                "access_token": access_token,
            },
            timeout=30,
        )
        r.raise_for_status()
        values = {}
        for d in r.json().get("data", []):
            values[d.get("name")] = d.get("total_value", {}).get("value")
        return values.get("profile_views"), values.get("accounts_engaged")
    except Exception:
        return None, None


def _fetch_instagram_post_audience_reach(media_id, access_token):
    """
    Igual que _fetch_instagram_audience_reach, pero para UN post puntual en
    vez de toda la cuenta: cuanto del alcance de ESTE post vino de gente que
    ya seguia el perfil vs. gente que no. Mismo mecanismo de Meta (metric
    'reach' con breakdown=follow_type), pedido sobre el media_id del post en
    vez del ig_business_id de la cuenta. A diferencia del de cuenta, acá se
    pide period='lifetime' (no days_28): el alcance de un post ya publicado
    es un numero acumulado que no vuelve a resetear cada 28 dias, es "lo que
    lleva acumulado desde que se publico".

    Facebook NO tiene un endpoint equivalente para posts de Pagina -- la
    Graph API publica no expone ese desglose para Facebook (solo existe para
    medios de Instagram), asi que esta funcion es Instagram-only. Lo que se
    ve en el "Insights do post" nativo de Facebook para Reels sale de datos
    internos de Meta Business Suite que no estan expuestos via API publica
    para apps de terceros -- por eso no hay forma de replicar ese mismo dato
    para posts de Facebook desde este scheduler.

    Devuelve (follower_reach, non_follower_reach). Best-effort: si Meta no
    tiene el dato todavia (post muy reciente, alcance insuficiente) o el
    permiso no alcanza, devuelve (None, None) en vez de cortar la corrida.
    """
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{media_id}/insights",
            params={
                "metric": "reach",
                "period": "lifetime",
                "metric_type": "total_value",
                "breakdown": "follow_type",
                "access_token": access_token,
            },
            timeout=30,
        )
        r.raise_for_status()
        data = r.json().get("data", [])
        if not data:
            return None, None
        breakdowns = data[0].get("total_value", {}).get("breakdowns", [])
        if not breakdowns:
            return None, None
        results = breakdowns[0].get("results", [])
        by_type = {}
        for item in results:
            dims = item.get("dimension_values") or []
            if dims:
                by_type[dims[0]] = item.get("value")
        return by_type.get("FOLLOWER"), by_type.get("NON_FOLLOWER")
    except Exception:
        return None, None


# ---------------------------------------------------------------------------
# Actualización 03/08/2026 (actualizacion_posts_y_metricas.txt, Parte 2):
# demográficos de audiencia (género+edad, país, ciudad), a nivel de CUENTA
# (Meta no da este desglose por post). ¡OJO! -- igual que ya paso con
# post_impressions (ver nota en _fetch_facebook_post_insights de mas
# arriba), Meta cambia nombres de metricas de insights sin mucho aviso.
# Los nombres usados aca (follower_demographics para Instagram,
# page_follows_country/page_follows_city para Facebook) son los vigentes
# al momento de escribir esto -- confirmar en Graph API Explorer contra la
# version de API que se este usando (GRAPH_API_VERSION) antes de correr
# esto en produccion por primera vez.
# ---------------------------------------------------------------------------
def _fetch_instagram_follower_demographics(ig_business_id, access_token, breakdown):
    """
    Desglose demografico de SEGUIDORES (no de alcance) de una cuenta de
    Instagram. metric='follower_demographics' con metric_type=total_value
    (mismo formato "breakdowns" que ya usa _fetch_instagram_audience_reach
    para 'reach'), period='lifetime' porque es una foto del total actual
    de seguidores, no una ventana movil de dias.

    breakdown: 'gender,age' (genero+edad combinados en un mismo dimension_
    values de a 2 elementos, EN ESE ORDEN -- Meta devuelve dimension_values
    respetando el orden pedido en el parametro 'breakdown'), 'country' o
    'city' (1 elemento). Devuelve una lista de (breakdown_key, value) --
    para gender,age arma la clave como 'GENERO.EDAD' (ej. 'F.35-44'); para
    country/city, el codigo/nombre tal cual lo devuelve Meta (hasta 45
    valores, los mas importantes primero).

    Devuelve [] (lista vacia) si Meta no tiene el dato todavia (cuenta con
    menos de 100 seguidores, por ejemplo -- Meta exige un piso de 100 para
    dar demograficos) o el permiso no alcanza. Best-effort, no corta la
    corrida.
    """
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{ig_business_id}/insights",
            params={
                "metric": "follower_demographics",
                "period": "lifetime",
                "metric_type": "total_value",
                "breakdown": breakdown,
                "access_token": access_token,
            },
            timeout=30,
        )
        r.raise_for_status()
        data = r.json().get("data", [])
        if not data:
            return []
        breakdowns = data[0].get("total_value", {}).get("breakdowns", [])
        if not breakdowns:
            return []
        results = breakdowns[0].get("results", [])
        out = []
        for item in results:
            dims = item.get("dimension_values") or []
            value = item.get("value")
            if not dims or value is None:
                continue
            # breakdown='gender,age' llega como dimension_values=[gender, age]
            # (orden = mismo orden en que se pidio el parametro 'breakdown').
            key = ".".join(dims) if len(dims) > 1 else dims[0]
            out.append((key, value))
        return out
    except Exception:
        return []


def _fetch_facebook_follower_geo(page_id, access_token, metric):
    """
    Desglose geografico (pais o ciudad) de seguidores de una Pagina de
    Facebook. metric: 'page_follows_country' o 'page_follows_city' --
    reemplazo de los viejos page_fans_country/page_fans_city, deprecados
    por Meta el 15/11/2025 (ver nota arriba de este bloque).

    A diferencia de follower_demographics de Instagram, este tipo de
    metrica "legacy" de Paginas no usa el formato metric_type=total_value
    con 'breakdowns' -- Meta la devuelve directo como un diccionario
    {pais_o_ciudad: cantidad} adentro de 'values'. Se deja el parseo
    tolerante a los dos formatos por si Meta lo migra mas adelante al
    mismo esquema que usa Instagram.

    Facebook NO expone genero/edad de seguidores de Pagina desde marzo
    2024 (deprecado sin reemplazo) -- por eso no existe un
    _fetch_facebook_follower_gender_age equivalente: esa columna queda
    vacia para cuentas platform='facebook' en socialbot_audience_demographics.

    Devuelve [] si Meta no tiene el dato o el permiso no alcanza.
    """
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/insights",
            params={"metric": metric, "period": "lifetime", "access_token": access_token},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json().get("data", [])
        if not data or not data[0].get("values"):
            return []
        raw_value = data[0]["values"][-1].get("value")
        if not raw_value:
            return []
        if isinstance(raw_value, dict):
            return list(raw_value.items())
        # Formato alternativo (por si Meta lo migro a 'breakdowns'), tolerado
        # por las dudas -- mismo parseo que _fetch_instagram_follower_demographics.
        breakdowns = raw_value.get("breakdowns", []) if isinstance(raw_value, dict) else []
        out = []
        for b in breakdowns:
            for item in b.get("results", []):
                dims = item.get("dimension_values") or []
                if dims and item.get("value") is not None:
                    out.append((dims[0], item.get("value")))
        return out
    except Exception:
        return []


def collect_audience_demographics():
    """
    Trae y guarda el snapshot demografico de audiencia (genero+edad, pais,
    ciudad) de CADA cuenta conectada -- Instagram con los 3 tipos via
    _fetch_instagram_follower_demographics, Facebook solo country/city via
    _fetch_facebook_follower_geo (Meta no da genero/edad de Paginas desde
    2024). Guarda en socialbot_audience_demographics -- upsert por
    (social_account_id, breakdown_type, breakdown_key), y ANTES de insertar
    borra (sb_delete) las filas viejas de ese social_account_id+breakdown_type
    que ya no vinieron en esta corrida (ej. una ciudad que salio del top-45),
    para no dejar claves huerfanas de corridas anteriores.

    Se corre junto con el resto de las recolecciones de audiencia
    (collect_audience_reach, collect_facebook_page_engagement).
    """
    accounts = sb_get(
        "socialbot_social_accounts",
        {"select": "id,platform,page_id,ig_business_id,page_access_token,page_name"},
    )
    if not accounts:
        return

    print(f"Actualizando demograficos de audiencia de {len(accounts)} cuenta(s)...")
    updated = 0
    for account in accounts:
        platform = account.get("platform")
        access_token = account.get("page_access_token")
        try:
            # breakdown_type -> lista de (breakdown_key, value) a guardar
            fetched_by_type = {}
            if platform == "instagram":
                ig_id = account.get("ig_business_id")
                if not ig_id or not access_token:
                    continue
                fetched_by_type["gender_age"] = _fetch_instagram_follower_demographics(ig_id, access_token, "gender,age")
                fetched_by_type["country"] = _fetch_instagram_follower_demographics(ig_id, access_token, "country")
                fetched_by_type["city"] = _fetch_instagram_follower_demographics(ig_id, access_token, "city")
            elif platform == "facebook":
                page_id = account.get("page_id")
                if not page_id or not access_token:
                    continue
                fetched_by_type["country"] = _fetch_facebook_follower_geo(page_id, access_token, "page_follows_country")
                fetched_by_type["city"] = _fetch_facebook_follower_geo(page_id, access_token, "page_follows_city")
                # No hay fetched_by_type["gender_age"] para Facebook a proposito.
            else:
                continue

            any_data = False
            for breakdown_type, rows in fetched_by_type.items():
                if not rows:
                    continue  # sin dato nuevo -- no tocamos lo que ya estaba guardado de este tipo
                any_data = True
                sb_delete(
                    "socialbot_audience_demographics",
                    {"social_account_id": f"eq.{account['id']}", "breakdown_type": f"eq.{breakdown_type}"},
                )
                sb_upsert(
                    "socialbot_audience_demographics",
                    [
                        {
                            "social_account_id": account["id"],
                            "breakdown_type": breakdown_type,
                            "breakdown_key": key,
                            "value": value,
                            "fetched_at": datetime.now(timezone.utc).isoformat(),
                        }
                        for key, value in rows
                    ],
                    on_conflict="social_account_id,breakdown_type,breakdown_key",
                )
            if any_data:
                updated += 1
        except Exception as e:
            print(f"ERROR actualizando demograficos de {account.get('page_name') or account['id']}: {e}")

    print(f"Demograficos de audiencia actualizados: {updated}/{len(accounts)}.")


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


def _fetch_facebook_page_engagement(page_id, access_token, period="days_28"):
    """
    'page_post_engagements' es un KPI de CUENTA (no de un post puntual):
    suma de reacciones, comentarios, compartidos y clics de TODOS los posts
    de la Pagina en la ventana elegida (days_28, ventana movil agregada,
    igual criterio que _fetch_instagram_audience_reach). Sirve para dar a
    Facebook un equivalente de "engagement real" parecido a
    accounts_engaged de Instagram, pero a nivel de Pagina en vez de cuenta
    de Instagram.

    A diferencia de las metricas de post (_fetch_facebook_post_insights),
    Page Insights NO usa metric_type=total_value -- devuelve directamente
    values=[{value: N}] por period, tomamos el ultimo (el mas reciente).

    Devuelve el numero o None (Pagina sin datos todavia, token vencido,
    permiso insuficiente, etc. -- best-effort, no corta la corrida).
    """
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id}/insights",
            params={"metric": "page_post_engagements", "period": period, "access_token": access_token},
            timeout=30,
        )
        r.raise_for_status()
        data = r.json().get("data", [])
        if not data:
            return None
        values = data[0].get("values", [])
        if not values:
            return None
        return values[-1].get("value")
    except Exception:
        return None


def _fetch_instagram_reel_metrics(media_id, access_token):
    """
    'plays' (cuantas veces se reprodujo) e 'ig_reels_avg_watch_time' (tiempo
    promedio de reproduccion, en milisegundos) de un Reel puntual. Estas dos
    metricas SOLO existen para media_type='REELS' -- pedirlas sobre una
    imagen o un carrusel devuelve error de Meta, por eso solo se llama a
    esta funcion cuando ya se sabe que el post es un Reel (ver
    fetch_post_metrics).

    Juntas dicen si la gente ve el video completo o lo abandona a los
    primeros segundos -- dato que hasta ahora no se pedia para ningun tipo
    de post.

    Devuelve (plays, avg_watch_time_ms). Best-effort: si Meta no tiene el
    dato todavia (reel muy reciente) o el permiso no alcanza, devuelve
    (None, None) en vez de cortar la corrida.
    """
    try:
        # Meta deprecó 'plays' el 21/abr/2025 -- lo unifico bajo 'views' para
        # todos los formatos (Reels, posts, Stories). El valor sigue
        # significando lo mismo (reproducciones), solo cambio el nombre que
        # le pido a la API; la columna en socialbot_post_metrics sigue
        # llamandose 'plays' para no tener que migrar nada.
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{media_id}/insights",
            params={"metric": "views,ig_reels_avg_watch_time", "access_token": access_token},
            timeout=30,
        )
        r.raise_for_status()
        values = {}
        for d in r.json().get("data", []):
            if d.get("values"):
                values[d["name"]] = d["values"][0]["value"]
        return values.get("views"), values.get("ig_reels_avg_watch_time")
    except requests.HTTPError as e:
        # Antes esto tragaba el error en silencio (except Exception generico) y
        # por eso paso desapercibido meses: 'plays' quedo deprecado y la
        # llamada empezo a fallar con 400 sin que quedara rastro en ningun log.
        detail = e.response.text[:200] if e.response is not None else str(e)
        print(f"No se pudieron traer metricas de Reel para {media_id}: {detail}")
        return None, None
    except Exception as e:
        print(f"No se pudieron traer metricas de Reel para {media_id}: {e}")
        return None, None


def fetch_post_metrics(platform, external_id, access_token, media_type=None):
    """
    Devuelve un dict {likes, comments, shares, reach, impressions, saved,
    plays, avg_watch_time_ms} o None si no se pudo traer nada (post
    borrado, token vencido, etc. -- se loguea y se sigue con el resto, no
    corta la corrida).

    'media_type' es el valor generico guardado en socialbot_posts (viene de
    socialbot_media.media_type: 'image' | 'video' | 'carousel'), NO el tipo
    especifico que usa la Graph API de Instagram. publish_instagram() ya
    convierte cualquier video en REELS al publicar (ver payload["media_type"]
    = "REELS" en esa funcion) -- por eso aca, para Instagram, media_type ==
    'video' es lo que indica "esto es un Reel, pedile plays/avg_watch_time".
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
            # Facebook no tiene un equivalente directo de "guardados" ni del
            # desglose seguidor/no-seguidor a nivel de post -- quedan en None
            # (no es "no se pudo traer", es "no existe esta metrica para
            # esta plataforma" -- ver _fetch_instagram_post_audience_reach).
            return {
                "likes": likes, "comments": comments, "shares": shares, "reach": reach, "impressions": impressions,
                "saved": None, "follower_reach": None, "non_follower_reach": None,
                # 'plays'/'avg_watch_time_ms' son metricas de Reels de Instagram --
                # no existen para Facebook, quedan en None (no es "no se pudo
                # traer", es "no aplica a esta plataforma").
                "plays": None, "avg_watch_time_ms": None,
            }
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
            reach, saved = _fetch_instagram_reach_and_saved(external_id, access_token)
            follower_reach, non_follower_reach = _fetch_instagram_post_audience_reach(external_id, access_token)
            # 'plays'/'avg_watch_time_ms' solo existen para Reels (media_type
            # local == 'video', que publish_instagram() sube como REELS) --
            # pedirlas sobre una imagen o carrusel devuelve error de Meta, por
            # eso solo se llama a _fetch_instagram_reel_metrics cuando
            # corresponde. Para el resto de los posts de Instagram quedan en
            # None (no aplica, no "no se pudo traer").
            plays, avg_watch_time_ms = (
                _fetch_instagram_reel_metrics(external_id, access_token) if media_type == "video" else (None, None)
            )
            return {
                "likes": likes, "comments": comments, "shares": 0, "reach": reach, "impressions": None, "saved": saved,
                # Solo Instagram -- Facebook no tiene este desglose por post (ver
                # _fetch_instagram_post_audience_reach). Quedan en None para posts
                # de Facebook, no se pisa nada del lado de esa rama del if.
                "follower_reach": follower_reach, "non_follower_reach": non_follower_reach,
                "plays": plays, "avg_watch_time_ms": avg_watch_time_ms,
            }
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
            "select": "id,external_post_id,social_account_id,metrics_fetch_failures,media_type",
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

            metrics = fetch_post_metrics(account["platform"], clean_id, account["page_access_token"], media_type=post.get("media_type"))
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


def collect_audience_reach():
    """
    Trae, para cada cuenta de Instagram conectada, el alcance de CUENTA (no
    por post) desglosado en seguidor/no seguidor de los ultimos 28 dias
    (_fetch_instagram_audience_reach), y lo pisa -- upsert por
    social_account_id -- en socialbot_audience_reach. Solo se guarda el
    ultimo total, no hay historial dia por dia (alcanza con eso: es lo que
    pidio la agencia, "un total me conformo"). Se corre junto con
    collect_post_metrics() al principio de cada ejecucion del scheduler.

    Facebook no tiene un equivalente directo de "follow_type" para Paginas
    (ese desglose es especifico de cuentas de Instagram), asi que esto solo
    aplica a cuentas platform='instagram'.
    """
    accounts = sb_get(
        "socialbot_social_accounts",
        {"platform": "eq.instagram", "select": "id,ig_business_id,page_access_token,page_name"},
    )
    if not accounts:
        return

    print(f"Actualizando alcance seguidor/no-seguidor de {len(accounts)} cuenta(s) de Instagram...")
    updated = 0
    for account in accounts:
        ig_business_id = account.get("ig_business_id")
        access_token = account.get("page_access_token")
        if not ig_business_id or not access_token:
            continue
        try:
            follower_reach, non_follower_reach = _fetch_instagram_audience_reach(ig_business_id, access_token)
            profile_views, accounts_engaged = _fetch_instagram_account_engagement(ig_business_id, access_token)
            if follower_reach is None and non_follower_reach is None and profile_views is None and accounts_engaged is None:
                continue  # Meta no tiene ningun dato todavia para esta cuenta -- no pisamos el ultimo valor bueno que hubiera

            # Solo se incluyen las columnas que SI se pudieron traer en esta
            # corrida -- si por ejemplo _fetch_instagram_audience_reach falla
            # pero _fetch_instagram_account_engagement funciona (o
            # viceversa), no queremos pisar con null un valor bueno que ya
            # estaba guardado de una corrida anterior.
            payload = {
                "social_account_id": account["id"],
                "period": "days_28",
                "fetched_at": datetime.now(timezone.utc).isoformat(),
            }
            if follower_reach is not None or non_follower_reach is not None:
                payload["follower_reach"] = follower_reach
                payload["non_follower_reach"] = non_follower_reach
            if profile_views is not None:
                payload["profile_views"] = profile_views
            if accounts_engaged is not None:
                payload["accounts_engaged"] = accounts_engaged

            sb_upsert("socialbot_audience_reach", [payload], on_conflict="social_account_id")
            updated += 1
        except Exception as e:
            print(f"ERROR actualizando alcance seguidor/no-seguidor de {account.get('page_name') or account['id']}: {e}")

    print(f"Alcance seguidor/no-seguidor actualizado: {updated}/{len(accounts)}.")


def collect_engagement_snapshots():
    """
    Punto 3 de propuestas-30-07-2026.md. socialbot_audience_reach solo
    guarda el ULTIMO snapshot por cuenta (se pisa en cada corrida) -- no
    alcanza para calcular un % de variacion del engagement rate vs. el
    periodo anterior en el panel. Esta funcion agrega esos numeros por
    CLIENTE (sumando todas sus cuentas de Instagram, igual criterio que
    renderMetrics() en metrics.js) y guarda 1 fila por cliente por dia en
    socialbot_engagement_snapshots -- mismo patron de "upsert por
    (client_id, snapshot_date)" que collect_follower_snapshots() usa para
    seguidores.

    Se corre DESPUES de collect_audience_reach() en la misma ejecucion,
    para leer los numeros recien actualizados de socialbot_audience_reach
    en vez de tener que volver a pedirle nada a Meta.
    """
    accounts = sb_get(
        "socialbot_social_accounts",
        {
            "platform": "eq.instagram",
            "select": "client_id,socialbot_audience_reach(follower_reach,non_follower_reach,accounts_engaged)",
        },
    )
    if not accounts:
        return

    # Suma follower_reach+non_follower_reach y accounts_engaged por
    # client_id -- una cuenta de Instagram sin dato todavia (sin fila en
    # socialbot_audience_reach, o con accounts_engaged null) simplemente no
    # aporta nada a la suma de su cliente.
    totals_by_client = {}
    for acc in accounts:
        client_id = acc.get("client_id")
        if not client_id:
            continue
        row = acc.get("socialbot_audience_reach")
        row = row[0] if isinstance(row, list) and row else (row if isinstance(row, dict) else None)
        if not row:
            continue
        if client_id not in totals_by_client:
            totals_by_client[client_id] = {"reach": 0, "engaged": 0, "has_data": False}
        t = totals_by_client[client_id]
        if row.get("accounts_engaged") is not None and (row.get("follower_reach") or row.get("non_follower_reach")):
            t["has_data"] = True
            t["reach"] += (row.get("follower_reach") or 0) + (row.get("non_follower_reach") or 0)
            t["engaged"] += row["accounts_engaged"]

    if not totals_by_client:
        return

    print(f"Guardando snapshot de engagement rate de {len(totals_by_client)} cliente(s)...")
    today_iso = datetime.now(timezone.utc).date().isoformat()
    saved = 0
    for client_id, t in totals_by_client.items():
        if not t["has_data"]:
            continue  # sin dato todavia -- no guardamos una fila con 0/null que despues se lea como "cayo a 0"
        engagement_rate = round((t["engaged"] / t["reach"]) * 100, 2) if t["reach"] else None
        try:
            sb_upsert(
                "socialbot_engagement_snapshots",
                [{
                    "client_id": client_id,
                    "snapshot_date": today_iso,
                    "engagement_rate": engagement_rate,
                    "accounts_engaged": t["engaged"],
                    "audience_reach": t["reach"],
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                }],
                on_conflict="client_id,snapshot_date",
            )
            saved += 1
        except Exception as e:
            print(f"ERROR guardando snapshot de engagement de cliente {client_id}: {e}")

    print(f"Snapshots de engagement rate guardados: {saved}/{len(totals_by_client)}.")


def collect_facebook_page_engagement():
    """
    Trae, para cada Pagina de Facebook conectada, el engagement total de
    los ultimos 28 dias (_fetch_facebook_page_engagement) y lo guarda --
    upsert por social_account_id, igual que collect_audience_reach() -- en
    socialbot_audience_reach (columna page_engagement). Va en funcion
    separada (en vez de meterse dentro de collect_audience_reach) porque
    esa funcion filtra explicitamente platform='instagram' y arma su propio
    payload sobre esa base; separarlo evita tocar ese flujo que ya esta
    probado en produccion.

    Es el equivalente, para Facebook, de lo que accounts_engaged es para
    Instagram: un solo numero de "engagement real" a nivel de cuenta. No
    hay historial dia por dia, solo el ultimo valor (mismo criterio que el
    resto de esta tabla). Se corre junto con collect_audience_reach() al
    principio de cada ejecucion del scheduler.
    """
    accounts = sb_get(
        "socialbot_social_accounts",
        {"platform": "eq.facebook", "select": "id,page_id,page_access_token,page_name"},
    )
    if not accounts:
        return

    print(f"Actualizando engagement de pagina de {len(accounts)} cuenta(s) de Facebook...")
    updated = 0
    for account in accounts:
        page_id = account.get("page_id")
        access_token = account.get("page_access_token")
        if not page_id or not access_token:
            continue
        try:
            page_engagement = _fetch_facebook_page_engagement(page_id, access_token)
            if page_engagement is None:
                continue  # Meta no tiene dato todavia -- no pisamos un valor bueno anterior

            sb_upsert(
                "socialbot_audience_reach",
                [{
                    "social_account_id": account["id"],
                    "period": "days_28",
                    "page_engagement": page_engagement,
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                }],
                on_conflict="social_account_id",
            )
            updated += 1
        except Exception as e:
            print(f"ERROR actualizando engagement de pagina de {account.get('page_name') or account['id']}: {e}")

    print(f"Engagement de pagina actualizado: {updated}/{len(accounts)}.")


def _fetch_follower_count(platform, page_id_or_ig_id, access_token):
    """
    Numero total de seguidores/fans de la cuenta AHORA MISMO (no un
    historico -- eso lo arma collect_follower_snapshots() guardando un
    snapshot por dia). Instagram usa 'followers_count' sobre el ig_business_id;
    Facebook usa 'fan_count' sobre el page_id -- son campos normales del
    objeto (no /insights), asi que es una sola llamada liviana.

    Devuelve el numero o None (post/pagina sin permiso, token vencido, etc.
    -- best-effort, no corta la corrida).
    """
    field = "followers_count" if platform == "instagram" else "fan_count"
    try:
        r = requests.get(
            f"https://graph.facebook.com/{GRAPH_API_VERSION}/{page_id_or_ig_id}",
            params={"fields": field, "access_token": access_token},
            timeout=30,
        )
        r.raise_for_status()
        return r.json().get(field)
    except Exception:
        return None


def collect_follower_snapshots():
    """
    Guarda, para CADA cuenta social conectada (Facebook y Instagram), el
    numero total de seguidores/fans de hoy en socialbot_follower_snapshots
    -- upsert por (social_account_id, snapshot_date), asi que corridas
    repetidas el mismo dia pisan la misma fila en vez de acumular una por
    corrida (el scheduler corre cada 15 min). Con snapshots de varios dias
    guardados, el panel de agencia calcula la variacion semanal comparando
    el ultimo contra el mas cercano a 7 dias atras.

    Se corre junto con collect_post_metrics() y collect_audience_reach() al
    principio de cada ejecucion del scheduler.
    """
    accounts = sb_get(
        "socialbot_social_accounts",
        {"select": "id,platform,page_id,ig_business_id,page_access_token,page_name"},
    )
    if not accounts:
        return

    print(f"Actualizando seguidores totales de {len(accounts)} cuenta(s)...")
    updated = 0
    for account in accounts:
        platform = account.get("platform")
        access_token = account.get("page_access_token")
        target_id = account.get("ig_business_id") if platform == "instagram" else account.get("page_id")
        if not target_id or not access_token:
            continue
        try:
            follower_count = _fetch_follower_count(platform, target_id, access_token)
            if follower_count is None:
                continue

            sb_upsert(
                "socialbot_follower_snapshots",
                [{
                    "social_account_id": account["id"],
                    "follower_count": follower_count,
                    "snapshot_date": datetime.now(timezone.utc).date().isoformat(),
                    "fetched_at": datetime.now(timezone.utc).isoformat(),
                }],
                on_conflict="social_account_id,snapshot_date",
            )
            updated += 1
        except Exception as e:
            print(f"ERROR actualizando seguidores de {account.get('page_name') or account['id']}: {e}")

    print(f"Seguidores totales actualizados: {updated}/{len(accounts)}.")


def collect_weekly_client_snapshot():
    """
    Dashboard consolidado multi-cliente (agencia) -- ver
    socialbot_client_weekly_snapshots. Guarda, para cada cliente activo,
    una fila por semana (week_start = lunes UTC) con 7 metricas, en dos
    familias segun como se combinan dia a dia:

    - FLUJO (likes, comments, leads, leads_convertidos, clics_link): se
      RECALCULAN DESDE CERO cada vez que corre esta funcion, sumando todo
      lo real desde el lunes de esta semana hasta ahora. No se hace
      "total += lo de hoy" porque si el job llegara a correr 2 veces el
      mismo dia (o se reintenta despues de un fallo) eso duplicaria el
      conteo -- recalcular desde el origen de la semana es mas lento pero
      no puede desincronizarse nunca.

    - FOTO (seguidores_totales, reach): se PISA con el ultimo valor
      conocido, nunca se suma. Sumar seguidores o reach dia a dia
      inflaria el numero sin sentido (un cliente con 500 seguidores el
      lunes sigue teniendo esos mismos 500 el martes, no se duplican).
      seguidores_totales sale de socialbot_follower_snapshots (snapshot
      diario ya poblado por collect_follower_snapshots(), que corre antes
      que esta funcion en run()). reach sale de socialbot_audience_reach
      (ventana movil de 28 dias que da Meta, ya poblada por
      collect_audience_reach()).

    Con esto, la fila de la semana en curso va reflejando el total real
    "hasta hoy" en cada corrida, y queda definitiva recien el domingo a
    la noche -- que es el valor que compara el semaforo del panel de
    agencia contra la semana anterior. Por eso la primera comparacion
    valida recien esta disponible a las 2 semanas de activar esto (se
    necesitan 2 filas cerradas para comparar).

    Se corre al final de run(), despues de collect_follower_snapshots()
    y collect_audience_reach(), para leer numeros ya actualizados en vez
    de volver a pedirle nada a Meta.
    """
    clients = sb_get("socialbot_clients", {"active": "eq.true", "select": "id,name"})
    if not clients:
        return

    now_utc = datetime.now(timezone.utc)
    today = now_utc.date()
    week_start = today - timedelta(days=today.weekday())  # lunes ISO de esta semana
    week_start_iso = f"{week_start.isoformat()}T00:00:00Z"
    tomorrow_iso = f"{(today + timedelta(days=1)).isoformat()}T00:00:00Z"

    print(f"Actualizando snapshot semanal (semana del {week_start.isoformat()}) de {len(clients)} cliente(s)...")
    saved = 0
    for client in clients:
        client_id = client["id"]
        try:
            # --- FLUJO: recalculado desde el lunes hasta ahora ---
            posts = sb_get(
                "socialbot_posts",
                {
                    "client_id": f"eq.{client_id}",
                    "status": "eq.published",
                    "and": f"(published_at.gte.{week_start_iso},published_at.lt.{tomorrow_iso})",
                    "select": "socialbot_post_metrics(likes,comments)",
                },
            ) or []
            likes = sum((p.get("socialbot_post_metrics") or {}).get("likes") or 0 for p in posts)
            comments = sum((p.get("socialbot_post_metrics") or {}).get("comments") or 0 for p in posts)

            leads_rows = sb_get(
                "socialbot_leads",
                {
                    "client_id": f"eq.{client_id}",
                    "and": f"(created_at.gte.{week_start_iso},created_at.lt.{tomorrow_iso})",
                    "select": "id",
                },
            ) or []
            leads = len(leads_rows)

            # "Convertido esta semana" = paso a status=convertido en algun
            # momento entre el lunes y hoy (usa updated_at -- no hay
            # historial de cambio de estado, es la mejor aproximacion
            # disponible sin agregar una tabla nueva de eventos).
            converted_rows = sb_get(
                "socialbot_leads",
                {
                    "client_id": f"eq.{client_id}",
                    "status": "eq.convertido",
                    "and": f"(updated_at.gte.{week_start_iso},updated_at.lt.{tomorrow_iso})",
                    "select": "id",
                },
            ) or []
            leads_convertidos = len(converted_rows)

            click_rows = sb_get(
                "socialbot_link_clicks",
                {
                    "client_id": f"eq.{client_id}",
                    "and": f"(clicked_at.gte.{week_start_iso},clicked_at.lt.{tomorrow_iso})",
                    "select": "id",
                },
            ) or []
            clics_link = len(click_rows)

            # --- FOTO: ultimo valor conocido, se pisa, no se suma ---
            accounts = sb_get(
                "socialbot_social_accounts",
                {
                    "client_id": f"eq.{client_id}",
                    "select": "platform,socialbot_follower_snapshots(follower_count,snapshot_date),socialbot_audience_reach(follower_reach,non_follower_reach)",
                },
            ) or []

            seguidores_totales = 0
            has_followers_data = False
            reach = 0
            has_reach_data = False
            for acc in accounts:
                snaps = acc.get("socialbot_follower_snapshots")
                snaps = snaps if isinstance(snaps, list) else ([snaps] if snaps else [])
                snaps = [s for s in snaps if s and s.get("follower_count") is not None]
                if snaps:
                    latest = max(snaps, key=lambda s: s["snapshot_date"])
                    seguidores_totales += latest["follower_count"]
                    has_followers_data = True

                if acc.get("platform") == "instagram":
                    ar = acc.get("socialbot_audience_reach")
                    ar = ar[0] if isinstance(ar, list) and ar else (ar if isinstance(ar, dict) else None)
                    if ar and (ar.get("follower_reach") is not None or ar.get("non_follower_reach") is not None):
                        reach += (ar.get("follower_reach") or 0) + (ar.get("non_follower_reach") or 0)
                        has_reach_data = True

            payload = {
                "client_id": client_id,
                "week_start": week_start.isoformat(),
                "likes": likes,
                "comments": comments,
                "leads": leads,
                "leads_convertidos": leads_convertidos,
                "clics_link": clics_link,
                "computed_at": now_utc.isoformat(),
            }
            # Si todavia no hay dato de seguidores/reach para este cliente
            # (cuenta recien conectada), no pisamos con 0 -- se deja NULL y
            # el semaforo simplemente ignora esa metrica puntual esa semana.
            if has_followers_data:
                payload["seguidores_totales"] = seguidores_totales
            if has_reach_data:
                payload["reach"] = reach

            sb_upsert("socialbot_client_weekly_snapshots", [payload], on_conflict="client_id,week_start")
            saved += 1
        except Exception as e:
            print(f"ERROR actualizando snapshot semanal de {client.get('name') or client_id}: {e}")

    print(f"Snapshot semanal actualizado: {saved}/{len(clients)}.")


def run():
    """
    Corre las 7 recolecciones en orden, cada una best-effort (un fallo en
    una no frena a las demas). Pensado para GitHub Actions: no hay servidor
    ni loop, se ejecuta una vez y termina.
    """
    now_utc = datetime.now(timezone.utc)
    print(f"[{now_utc.isoformat()}] Iniciando recoleccion de metricas...")

    try:
        collect_post_metrics()
    except Exception as e:
        print(f"ERROR actualizando metricas de posts (no se corta la corrida): {e}")

    try:
        collect_audience_reach()
    except Exception as e:
        print(f"ERROR actualizando alcance seguidor/no-seguidor (no se corta la corrida): {e}")

    try:
        collect_engagement_snapshots()
    except Exception as e:
        print(f"ERROR guardando snapshot de engagement rate (no se corta la corrida): {e}")

    try:
        collect_facebook_page_engagement()
    except Exception as e:
        print(f"ERROR actualizando engagement de pagina de Facebook (no se corta la corrida): {e}")

    try:
        collect_audience_demographics()
    except Exception as e:
        print(f"ERROR actualizando demograficos de audiencia (no se corta la corrida): {e}")

    try:
        collect_follower_snapshots()
    except Exception as e:
        print(f"ERROR actualizando seguidores totales (no se corta la corrida): {e}")

    try:
        collect_weekly_client_snapshot()
    except Exception as e:
        print(f"ERROR actualizando snapshot semanal multi-cliente (no se corta la corrida): {e}")

    print(f"[{datetime.now(timezone.utc).isoformat()}] Recoleccion de metricas terminada.")


if __name__ == "__main__":
    run()
