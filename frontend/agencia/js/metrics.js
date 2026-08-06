// js/metrics.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { PLATFORM_META_AG, metricLocationView, metricPeriod, metricPlatform, sb } from "./state.js";
import { normalizeUrl } from "./utils.js";

// ---------------------------------------------------------------------------
// Resumen de métricas a demanda (mejora post-roadmap, no es el reporte
// mensual automático de scheduler/monthly_report.py -- ese sigue corriendo
// solo el día 1 de cada mes). Esto llama a la Edge Function
// send-report-now, que valida server-side que el cliente elegido
// pertenezca a esta agencia antes de mandar nada.
// ---------------------------------------------------------------------------
function onReportPeriodChange(clientId){
  const period = document.getElementById(`reportPeriod-${clientId}`).value;
  const show = period === 'custom';
  document.getElementById(`reportStart-${clientId}`).style.display = show ? 'inline-block' : 'none';
  document.getElementById(`reportEnd-${clientId}`).style.display = show ? 'inline-block' : 'none';
}
function computeReportRange(period, clientId){
  const fmt = d => d.toISOString().slice(0, 10);
  const today = new Date();
  if(period === 'this_month'){
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    return { start: fmt(start), end: fmt(today) };
  }
  if(period === 'last_month'){
    const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
    const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0)); // último día del mes anterior
    return { start: fmt(start), end: fmt(end) };
  }
  if(period === 'last_30_days'){
    const start = new Date(today.getTime() - 29 * 24 * 3600 * 1000);
    return { start: fmt(start), end: fmt(today) };
  }
  // custom
  return {
    start: document.getElementById(`reportStart-${clientId}`).value,
    end: document.getElementById(`reportEnd-${clientId}`).value,
  };
}
async function sendReportNow(clientId){
  const period = document.getElementById(`reportPeriod-${clientId}`).value;
  const { start, end } = computeReportRange(period, clientId);
  if(!start || !end){ alert('Elegí un rango de fechas válido.'); return; }

  const btn = event.target;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Enviando...';
  try {
    const { data, error } = await sb.functions.invoke('send-report-now', {
      body: { client_id: clientId, start_date: start, end_date: end }
    });
    if(error) throw error;
    if(data && data.error) throw new Error(data.error);
    alert(
      `Resumen enviado a ${data.sent_to} (${data.period}):\n` +
      `Consultas: ${data.consultas_recibidas} · Clientes nuevos: ${data.clientes_nuevos} · ` +
      `Posts: ${data.posts_publicados} · Me gusta: ${data.me_gusta}`
    );
  } catch(err){
    alert(`No se pudo enviar: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
// ---------------------------------------------------------------------------
// Métricas — agrupa registros por semana (lunes a domingo) o por mes
// calendario, según el toggle Semanal/Mensual que elige la agencia por
// cliente, y los renderiza como barras simples con CSS puro. Mismo criterio
// (funciones espejo) en frontend/cliente.html.
// ---------------------------------------------------------------------------
function buildPeriodBuckets(period){
  const now = new Date();
  const buckets = [];
  if(period === 'month'){
    for(let i = 5; i >= 0; i--){
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
      buckets.push({ start, end, label: start.toLocaleDateString('es-AR', { month:'short' }) });
    }
  } else {
    for(let i = 7; i >= 0; i--){
      const start = new Date(now);
      const dow = (start.getDay() + 6) % 7; // 0=lunes .. 6=domingo
      start.setHours(0,0,0,0);
      start.setDate(start.getDate() - dow - (i * 7));
      const end = new Date(start);
      end.setDate(start.getDate() + 7);
      buckets.push({ start, end, label: `${start.getDate()}/${start.getMonth()+1}` });
    }
  }
  return buckets;
}
// Punto 3 de propuestas-30-07-2026.md: comparacion vs. periodo anterior.
// Devuelve un badge HTML con el % de variacion, o null si no hay base
// valida para compararlo (ambos en 0 -- "sin cambios" no aporta nada).
// previous=0 y current>0 se muestra como "nuevo" en vez de un % (division
// por cero no tiene sentido como porcentaje).
function pctDeltaBadge(current, previous, latestDateLabel){
  if(previous === 0 && current === 0) return '';
  if(previous === 0){
    // Actualización: cuando el badge dice "nuevo" (periodo anterior en 0),
    // se agrega la fecha/hora del registro más reciente que compone ese
    // total -- "nuevo" por si solo no dice si eso pasó hoy o hace 7
    // semanas (el período de comparación es de hasta 8 semanas/6 meses).
    const suffix = latestDateLabel ? ` (${latestDateLabel})` : '';
    return ` <span style="font-size:11px; font-weight:600; color:#5fae6a;">· nuevo${suffix}</span>`;
  }
  const pct = Math.round(((current - previous) / previous) * 100);
  if(pct === 0) return ` <span style="font-size:11px; font-weight:600; color:var(--muted);">· sin cambios</span>`;
  const positive = pct > 0;
  const color = positive ? '#5fae6a' : 'var(--warn)';
  const arrow = positive ? '▲' : '▼';
  return ` <span style="font-size:11px; font-weight:600; color:${color};">${arrow} ${Math.abs(pct)}%</span>`;
}
// Fecha/hora del registro más reciente de un set de filas, para el
// sufijo de pctDeltaBadge() cuando marca "nuevo" -- ej. "hasta 02/08 18:40".
function latestRowDateLabel(rows, dateField){
  const dates = (rows||[]).map(r => r[dateField]).filter(Boolean).map(d => new Date(d));
  if(!dates.length) return null;
  const latest = new Date(Math.max(...dates));
  return `hasta ${latest.toLocaleString('es-AR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' })}`;
}
// Igual idea que el sufijo de pctDeltaBadge, pero para tarjetas de conteo
// simple (sin comparación de periodo) -- Interacción en publicaciones y
// Clics al link: si hay actividad (rows no vacío tras filtrar por >0) se
// muestra la fecha/hora del más reciente; si está en 0, no se muestra nada.
function lastActivitySuffix(rows, dateField){
  const label = latestRowDateLabel(rows, dateField);
  return label ? ` <span style="font-size:11px; font-weight:600; color:var(--muted);">· ${label}</span>` : '';
}
function fillBuckets(buckets, rows, dateField, { replyField = null, sumField = null, filterFn = null } = {}){
  buckets.forEach(b => { b.count = 0; b.total = 0; b.replied = 0; b.sum = 0; });
  (rows||[]).forEach(r => {
    if(!r[dateField]) return;
    if(filterFn && !filterFn(r)) return;
    const d = new Date(r[dateField]);
    const b = buckets.find(b => d >= b.start && d < b.end);
    if(!b) return;
    b.count++;
    if(replyField){ b.total++; if(r[replyField]) b.replied++; }
    if(sumField){ b.sum += (r[sumField] || 0); }
  });
  return buckets;
}
function renderBarChart(containerEl, buckets, { rate = false, sum = false } = {}){
  const values = buckets.map(b => rate ? (b.total ? Math.round((b.replied / b.total) * 100) : 0) : (sum ? b.sum : b.count));
  const max = Math.max(1, ...values);
  containerEl.innerHTML = `
    <div class="chart-wrap">
      ${buckets.map((b, i) => {
        const value = values[i];
        const h = Math.max(3, (value / max) * 70);
        return `
          <div class="chart-bar-col">
            <div class="chart-bar" style="height:${h}px;" title="${b.label}: ${value}${rate ? '%' : ''}"></div>
            <div class="chart-label">${b.label}</div>
          </div>`;
      }).join('')}
    </div>`;
}
function setMetricPeriod(clientId, period){
  metricPeriod[clientId] = period;
  renderMetrics(clientId);
}
function setMetricPlatform(clientId, platform){
  metricPlatform[clientId] = platform;
  renderMetrics(clientId);
}
// Actualización 03/08/2026: toggle Países/Ciudades del bloque "Principales
// ubicaciones" (demográficos de audiencia) -- mismo patrón que
// setMetricPeriod/setMetricPlatform.
function setMetricLocationView(clientId, view){
  metricLocationView[clientId] = view;
  renderMetrics(clientId);
}
// ---------------------------------------------------------------------------
// Pestaña "Inicio": la última publicación del cliente seleccionado, mostrada
// como tarjeta estilo Instagram — mismo criterio que loadDashboard() en el
// portal del cliente (frontend/cliente/index.html). Recibe los `posts` ya
// traídos en loadClients() (no pega de nuevo a Supabase); busca el más
// reciente con status 'published' y, si no encuentra likes precargados
// (posts viene sin socialbot_post_metrics), los muestra en 0.
// ---------------------------------------------------------------------------
function renderHomeView(c, posts){
  const container = document.getElementById('homeList');
  if(!container) return;

  const published = (posts||[]).filter(p => p.status === 'published');
  published.sort((a, b) => new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at));
  const post = published[0] || null;

  if(!post){
    const logoSrc = c.logo_url ? normalizeUrl(c.logo_url) : null;
    container.innerHTML = `
      <div class="dash-empty">
        ${logoSrc ? `<img src="${logoSrc}" alt="" onerror="this.style.display='none';" />` : ''}
        <div>Todavía no hay publicaciones de ${c.name || 'este cliente'}.</div>
      </div>
    `;
    return;
  }

  const pMeta = PLATFORM_META_AG[post.platform] || { label: '', icon: '' };
  const likes = (post.socialbot_post_metrics && post.socialbot_post_metrics.likes) || 0;
  const dateLabel = (post.published_at || post.created_at) ? new Date(post.published_at || post.created_at).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
  const clientLogoSrc = c.logo_url ? normalizeUrl(c.logo_url) : null;
  const avatarHtml = clientLogoSrc
    ? `<img class="ig-avatar" src="${clientLogoSrc}" alt="" onerror="this.outerHTML='<div class=&quot;ig-avatar-fallback&quot;>${(c.name||'M')[0].toUpperCase()}</div>';" />`
    : `<div class="ig-avatar-fallback">${(c.name||'M')[0].toUpperCase()}</div>`;

  container.innerHTML = `
    <div class="ig-card">
      <div class="ig-head">
        ${avatarHtml}
        <div>
          <div class="ig-headname">${c.name || ''}</div>
          <div class="ig-headplatform">${pMeta.icon} ${pMeta.label}</div>
        </div>
      </div>
      ${post.media_url ? `<img class="ig-media" src="${post.media_url}" alt="" onerror="this.style.display='none';" />` : ''}
      <div class="ig-actions">
        <svg viewBox="0 0 24 24"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z"/></svg>
      </div>
      <div class="ig-likes">${likes} me gusta</div>
      ${post.caption ? `<div class="ig-caption"><b>${c.name || ''}</b>${post.caption.slice(0,220)}${post.caption.length>220?'...':''}</div>` : ''}
      <div class="ig-date">${dateLabel}</div>
      ${post.permalink_url ? `<div style="padding:0 14px 14px;"><a href="${post.permalink_url}" target="_blank" rel="noopener" style="font-size:12px; color:var(--white); text-decoration:underline; display:inline-flex; align-items:center; gap:4px;">Ver publicación en vivo<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a></div>` : ''}
    </div>
  `;
}
// KPIs reales que la agencia mira de un vistazo: consultas recibidas
// (leads), clientes nuevos (leads con status='convertido') y me gusta
// totales (suma de socialbot_post_metrics.likes de los posts publicados),
// mas los 3 graficos de siempre, todo dentro de la ventana elegida
// (ultimas 8 semanas o ultimos 6 meses).
async function renderMetrics(clientId){
  const period = metricPeriod[clientId] || 'week';
  const platform = metricPlatform[clientId] || 'all';
  const buckets = buildPeriodBuckets(period);
  const windowStartIso = buckets[0].start.toISOString();

  // Punto 3: mismo largo de ventana (8 semanas o 6 meses) corrido hacia
  // atras, para poder calcular el % de variacion vs. el periodo anterior.
  const windowMs = buckets[buckets.length - 1].end.getTime() - buckets[0].start.getTime();
  const prevWindowStartIso = new Date(buckets[0].start.getTime() - windowMs).toISOString();
  const prevWindowEndIso = windowStartIso;

  const [{ data: leads }, { data: interactions }, { data: postsWithMetrics }, { data: linkClicks }, { data: igAccountsRaw }, { data: fbAccountsRaw }, { data: followerSnapshotsRaw }, { data: prevLeads }, { data: prevPosts }, { data: engagementSnapshotsRaw }, { data: demographicsAccountsRaw }] = await Promise.all([
    sb.from('socialbot_leads').select('created_at, status, platform').eq('client_id', clientId).gte('created_at', windowStartIso),
    sb.from('socialbot_interactions_log').select('created_at, replied, replied_at, platform, type').eq('client_id', clientId).gte('created_at', windowStartIso),
    sb.from('socialbot_posts').select('published_at, platform, external_post_id, media_type, caption, media_url, permalink_url, socialbot_post_metrics(likes, comments, shares, reach, saved, plays, avg_watch_time_ms)').eq('client_id', clientId).eq('status', 'published').gte('published_at', windowStartIso),
    sb.from('socialbot_link_clicks').select('source, clicked_at, external_post_id').eq('client_id', clientId).gte('clicked_at', windowStartIso),
    // Alcance de cuenta (no por post, no depende del periodo semanal/mensual
    // de arriba) desglosado seguidor/no-seguidor -- ver
    // collect_audience_reach() en post_scheduler.py. Solo se guarda el
    // ultimo snapshot por cuenta, así que no hace falta filtrar por fecha.
    sb.from('socialbot_social_accounts').select('platform, socialbot_audience_reach(follower_reach, non_follower_reach, profile_views, accounts_engaged, online_followers, period, fetched_at)').eq('client_id', clientId).eq('platform', 'instagram'),
    // Engagement total de Pagina de Facebook (page_post_engagements) --
    // ver collect_facebook_page_engagement() en post_scheduler.py. Query
    // separada de la de arriba porque esta es platform='facebook' (la de
    // arriba es Instagram-only) y trae una columna distinta de la misma
    // tabla (socialbot_audience_reach.page_engagement).
    sb.from('socialbot_social_accounts').select('platform, page_name, socialbot_audience_reach(page_engagement, period, fetched_at)').eq('client_id', clientId).eq('platform', 'facebook'),
    // Historial de seguidores/fans totales (todas las plataformas) -- ver
    // collect_follower_snapshots() en post_scheduler.py. Tampoco depende
    // del periodo de arriba: se pide todo el historial guardado (como
    // mucho 1 fila por cuenta por dia) y se calcula la variacion semanal
    // aca abajo, comparando el ultimo contra el mas cercano a 7 dias atras.
    sb.from('socialbot_follower_snapshots').select('social_account_id, follower_count, snapshot_date, socialbot_social_accounts!inner(platform, page_name, client_id)').eq('socialbot_social_accounts.client_id', clientId).order('snapshot_date', { ascending: true }),
    // Punto 3: mismos datos que leads/posts de arriba pero para el periodo
    // anterior, solo los campos que hacen falta para los totales que se
    // comparan (leads/convertidos, likes, reach) -- no hace falta el resto
    // (interactions, link clicks, audiencia) porque esos no se comparan.
    sb.from('socialbot_leads').select('created_at, status, platform').eq('client_id', clientId).gte('created_at', prevWindowStartIso).lt('created_at', prevWindowEndIso),
    sb.from('socialbot_posts').select('platform, socialbot_post_metrics(likes, reach)').eq('client_id', clientId).eq('status', 'published').gte('published_at', prevWindowStartIso).lt('published_at', prevWindowEndIso),
    // Punto 3: historial diario de engagement rate (ver
    // collect_engagement_snapshots() en scheduler/metrics_collector.py) --
    // socialbot_audience_reach solo tiene el ultimo valor, esta tabla si
    // permite promediar por periodo y compararlo contra el anterior.
    sb.from('socialbot_engagement_snapshots').select('snapshot_date, engagement_rate').eq('client_id', clientId).gte('snapshot_date', prevWindowStartIso.slice(0, 10)),
    // Actualización 03/08/2026 (actualizacion_posts_y_metricas.txt, Parte 2):
    // demográficos de audiencia (género+edad, país, ciudad) -- ultimo
    // snapshot por cuenta, ver collect_audience_demographics() en
    // metrics_collector.py. No depende del periodo semanal/mensual de
    // arriba (es "una foto actual"), igual que socialbot_audience_reach.
    // Se trae de TODAS las cuentas del cliente (no se filtra por
    // plataforma en la query) y se separa despues, igual que igAccounts/
    // fbAccounts mas abajo, para respetar el selector de plataforma.
    sb.from('socialbot_social_accounts').select('platform, socialbot_audience_demographics(breakdown_type, breakdown_key, value)').eq('client_id', clientId),
  ]);

  let leadsRows = leads || [];
  let postsRows = (postsWithMetrics||[]).map(p => ({
    published_at: p.published_at,
    platform: p.platform,
    external_post_id: p.external_post_id,
    likes: (p.socialbot_post_metrics && p.socialbot_post_metrics.likes) || 0,
    comments: (p.socialbot_post_metrics && p.socialbot_post_metrics.comments) || 0,
    shares: (p.socialbot_post_metrics && p.socialbot_post_metrics.shares) || 0,
    // Punto 11 de propuestas-30-07-2026.md: reach real (ya corregido el bug
    // de Facebook que lo dejaba en null). Puede venir null si a esta altura
    // todavia no se pudo pedir la metrica -- se cuenta como 0 en la suma,
    // pero se guarda aparte cuantos posts SI tienen dato para no mostrar
    // "0 de alcance" cuando en realidad es "todavia no tenemos el dato".
    reach: (p.socialbot_post_metrics && p.socialbot_post_metrics.reach) ?? null,
    // 'saved' solo existe para Instagram (Facebook no tiene equivalente) --
    // mismo criterio que reach: null = "sin dato todavia", no "0 guardados".
    saved: (p.socialbot_post_metrics && p.socialbot_post_metrics.saved) ?? null,
    // media_type local (image/video/carousel) -- 'video' es lo que
    // publish_instagram() sube como Reel. Se usa para saber si corresponde
    // mostrar plays/avg_watch_time_ms (solo existen para Reels).
    media_type: p.media_type,
    // 'plays'/'avg_watch_time_ms': solo Reels de Instagram (ver
    // _fetch_instagram_reel_metrics en post_scheduler.py). Mismo criterio
    // que reach/saved: null = "sin dato todavia o no es un Reel".
    plays: (p.socialbot_post_metrics && p.socialbot_post_metrics.plays) ?? null,
    avg_watch_time_ms: (p.socialbot_post_metrics && p.socialbot_post_metrics.avg_watch_time_ms) ?? null,
    // Se usan solo para armar la card de "post destacado" (ver mas abajo) --
    // caption se recorta ahi mismo, no se toca aca.
    caption: p.caption,
    media_url: p.media_url,
    permalink_url: p.permalink_url,
  }));
  let interactionsRows = interactions || [];

  // Selector Facebook/Instagram/Todas: filtro client-side, no toca el
  // scheduler ni las queries de arriba (que ya traen "platform" en el
  // select). "Todas" no filtra nada.
  if(platform !== 'all'){
    leadsRows = leadsRows.filter(r => r.platform === platform);
    postsRows = postsRows.filter(p => p.platform === platform);
    interactionsRows = interactionsRows.filter(r => r.platform === platform);
  }

  // socialbot_link_clicks no tiene columna platform propia -- se resuelve
  // con un mapa external_post_id -> platform armado a partir de los posts
  // ya traidos arriba (ver plan-separar-metricas-facebook-instagram.txt).
  const platformByExternalId = {};
  (postsWithMetrics||[]).forEach(p => { if(p.external_post_id) platformByExternalId[p.external_post_id] = p.platform; });
  let linkClicksRows = linkClicks || [];
  if(platform !== 'all'){
    linkClicksRows = linkClicksRows.filter(c => platformByExternalId[c.external_post_id] === platform);
  }

  const leadsBuckets = fillBuckets(buildPeriodBuckets(period), leadsRows, 'created_at');
  const convertedBuckets = fillBuckets(buildPeriodBuckets(period), leadsRows, 'created_at', { filterFn: r => r.status === 'convertido' });
  const postsBuckets = fillBuckets(buildPeriodBuckets(period), postsRows, 'published_at');
  const likesBuckets = fillBuckets(buildPeriodBuckets(period), postsRows, 'published_at', { sumField: 'likes' });
  // Punto 11: fillBuckets suma r.reach || 0, lo cual esta bien para el
  // grafico (un post sin dato todavia no suma nada), pero para el total y
  // el KPI necesitamos distinguir "0 de alcance real" de "sin dato".
  const reachBuckets = fillBuckets(buildPeriodBuckets(period), postsRows.map(p => ({ ...p, reach: p.reach || 0 })), 'published_at', { sumField: 'reach' });
  const postsWithReach = postsRows.filter(p => p.reach !== null);
  const replyBuckets = fillBuckets(buildPeriodBuckets(period), interactionsRows, 'created_at', { replyField: 'replied' });

  const totalLeads = leadsRows.length;
  const totalConverted = leadsRows.filter(r => r.status === 'convertido').length;
  const totalLikes = postsRows.reduce((s, p) => s + p.likes, 0);
  // Comentarios reales (no cuenta las respuestas del bot -- Meta suma los
  // replies dentro de comments.summary(true).total_count / comments_count,
  // asi que sumar socialbot_post_metrics.comments mostraba de mas). Cuenta
  // filas reales de socialbot_interactions_log (type='comment'): meta-webhook
  // nunca crea fila para la respuesta del bot (filtra por senderId===page_id/
  // ig_business_id antes de reservar), y backfill-post-comments hace lo mismo
  // (mete el reply del bot en reply_text de la fila del comentario real, no
  // como fila aparte). Incluye Instagram y Facebook juntos cuando
  // platform==='all' (interactionsRows ya viene filtrado por plataforma).
  const commentInteractionsRows = interactionsRows.filter(r => r.type === 'comment');
  const totalComments = commentInteractionsRows.length;
  const totalShares = postsRows.reduce((s, p) => s + p.shares, 0);
  const totalReach = postsWithReach.reduce((s, p) => s + p.reach, 0);

  // Punto 3: mismos totales pero del periodo anterior, con el mismo filtro
  // de plataforma que el periodo actual, para poder mostrar el % de
  // variacion junto a cada KPI principal.
  let prevLeadsRows = prevLeads || [];
  let prevPostsRows = prevPosts || [];
  if(platform !== 'all'){
    prevLeadsRows = prevLeadsRows.filter(r => r.platform === platform);
    prevPostsRows = prevPostsRows.filter(p => p.platform === platform);
  }
  const prevTotalLeads = prevLeadsRows.length;
  const prevTotalConverted = prevLeadsRows.filter(r => r.status === 'convertido').length;
  const prevTotalLikes = prevPostsRows.reduce((s, p) => s + ((p.socialbot_post_metrics && p.socialbot_post_metrics.likes) || 0), 0);
  const prevTotalReach = prevPostsRows.reduce((s, p) => s + ((p.socialbot_post_metrics && p.socialbot_post_metrics.reach) || 0), 0);

  // 'saved' solo aplica a Instagram -- igual que con reach, separamos
  // cuantos posts tienen el dato realmente (no todos son de Instagram, y a
  // los de Facebook ese campo directamente no les corresponde).
  const postsWithSaved = postsRows.filter(p => p.saved !== null);
  const totalSaved = postsWithSaved.reduce((s, p) => s + p.saved, 0);
  // Reels de Instagram (media_type local === 'video') con dato de
  // plays/avg_watch_time -- ver _fetch_instagram_reel_metrics en
  // post_scheduler.py. avg_watch_time_ms se promedia entre Reels (no se
  // suma, es un promedio de Meta por Reel) y se convierte a segundos.
  const postsWithPlays = postsRows.filter(p => p.plays !== null);
  const totalPlays = postsWithPlays.reduce((s, p) => s + p.plays, 0);
  const postsWithWatchTime = postsRows.filter(p => p.avg_watch_time_ms !== null);
  const avgWatchTimeSeconds = postsWithWatchTime.length
    ? Math.round(postsWithWatchTime.reduce((s, p) => s + p.avg_watch_time_ms, 0) / postsWithWatchTime.length / 1000)
    : null;

  // Post destacado del periodo: el de mayor interaccion total (likes +
  // comments + shares + saved). Se usa interaccion total y no reach/
  // engagement-rate a proposito -- reach puede venir null (Meta todavia no
  // lo calculo) y dejaria afuera posts recientes que en realidad son el
  // mejor candidato; likes/comments nunca vienen null, asi que siempre hay
  // un post destacado en cuanto existe al menos 1 post con alguna
  // interaccion. Empate -> queda el primero encontrado (orden de llegada).
  let topPost = null, topScore = -1;
  postsRows.forEach(p => {
    const score = p.likes + p.comments + p.shares + (p.saved || 0);
    if (score > topScore) { topScore = score; topPost = p; }
  });
  // No tiene sentido destacar un post con 0 interacciones (recien publicado,
  // o de verdad no funciono) -- en ese caso no se muestra ninguna card.
  if (topPost && topScore <= 0) topPost = null;
  const windowLabel = period === 'week' ? 'últimas 8 semanas' : 'últimos 6 meses';

  const repliedWithTimes = interactionsRows.filter(r => r.replied && r.replied_at && r.created_at);
  const avgResponseMinutes = repliedWithTimes.length
    ? Math.round(repliedWithTimes.reduce((sum, r) => sum + (new Date(r.replied_at) - new Date(r.created_at)) / 60000, 0) / repliedWithTimes.length)
    : null;
  const avgResponseLabel = avgResponseMinutes === null ? '—' : (avgResponseMinutes < 1 ? '<1' : avgResponseMinutes);

  // Item 1 de propuestas-30-07-2026.md: clics reales al link del cliente
  // (socialbot_link_clicks), abiertos por canal para ver por dónde entra
  // el trafico que de verdad importa (a diferencia de likes/comments).
  const clicksBySource = { comment_reply: 0, dm_reply: 0, fallback_reply: 0, ai_reply: 0 };
  linkClicksRows.forEach(c => { if(c.source in clicksBySource) clicksBySource[c.source]++; });
  const totalClicks = Object.values(clicksBySource).reduce((s, n) => s + n, 0);

  // % de seguidores vs. no-seguidores sobre el alcance total de Instagram
  // (ver collect_audience_reach() en post_scheduler.py). Es un snapshot de
  // cuenta, no un total del periodo elegido arriba (semana/mes) -- por eso
  // se calcula aparte, sumando entre todas las cuentas de instagram del
  // cliente por si hubiera mas de una conectada.
  // Esta sección ya es Instagram-only (la query de arriba ya filtra
  // .eq('platform','instagram')) -- si eligieron "Facebook" en el selector,
  // no corresponde mostrarla (paso 5 del plan).
  const igAccounts = platform === 'facebook' ? [] : (igAccountsRaw || []);
  let followerReach = 0, nonFollowerReach = 0, hasAudienceData = false;
  let totalProfileViews = 0, hasProfileViewsData = false;
  let totalAccountsEngaged = 0, hasEngagedData = false;
  // Punto 4: horario de mayor actividad de la audiencia (online_followers,
  // ver _fetch_instagram_online_followers en metrics_collector.py) --
  // sumado hora por hora entre todas las cuentas de Instagram del cliente,
  // por si hubiera mas de una conectada.
  const onlineByHour = new Array(24).fill(0);
  let hasOnlineFollowersData = false;
  igAccounts.forEach(acc => {
    const row = Array.isArray(acc.socialbot_audience_reach) ? acc.socialbot_audience_reach[0] : acc.socialbot_audience_reach;
    if(row && (row.follower_reach != null || row.non_follower_reach != null)){
      hasAudienceData = true;
      followerReach += row.follower_reach || 0;
      nonFollowerReach += row.non_follower_reach || 0;
    }
    if(row && row.profile_views != null){
      hasProfileViewsData = true;
      totalProfileViews += row.profile_views;
    }
    if(row && row.accounts_engaged != null){
      hasEngagedData = true;
      totalAccountsEngaged += row.accounts_engaged;
    }
    if(row && row.online_followers){
      hasOnlineFollowersData = true;
      for(let h = 0; h < 24; h++){
        onlineByHour[h] += row.online_followers[String(h)] || 0;
      }
    }
  });
  // Top 3 horas con mas seguidores conectados, para resaltar como sugerencia.
  const topHours = onlineByHour
    .map((count, hour) => ({ hour, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3)
    .filter(h => h.count > 0);
  const totalAudienceReach = followerReach + nonFollowerReach;
  const followerPct = totalAudienceReach ? Math.round((followerReach / totalAudienceReach) * 100) : null;
  const nonFollowerPct = followerPct === null ? null : 100 - followerPct;
  // % de cuentas unicas que interactuaron sobre el alcance total -- solo
  // se puede calcular si tenemos ambos datos (accounts_engaged y el
  // alcance de cuenta desglosado).
  const engagementRate = (hasEngagedData && totalAudienceReach) ? Math.round((totalAccountsEngaged / totalAudienceReach) * 100) : null;

  // Punto 3: promedio de engagement_rate (socialbot_engagement_snapshots)
  // dentro de la ventana actual vs. la anterior -- a diferencia del resto
  // de los KPIs (que se SUMAN), esto es un promedio de un %, no un total.
  // Como la tabla recien se empieza a poblar de ahora en mas, es normal
  // que todavia no haya snapshots de periodos viejos -- en ese caso
  // simplemente no se muestra el badge (no hay con que comparar).
  const avgEngagementRate = (rows, fromIso, toIso) => {
    const vals = (rows||[]).filter(r => r.engagement_rate !== null && r.snapshot_date >= fromIso && r.snapshot_date < toIso).map(r => r.engagement_rate);
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const engagementRateSnapshots = engagementSnapshotsRaw || [];
  const prevAvgEngagementRate = avgEngagementRate(engagementRateSnapshots, prevWindowStartIso.slice(0, 10), prevWindowEndIso.slice(0, 10));

  // Engagement de Pagina de Facebook (page_post_engagements) -- ver
  // collect_facebook_page_engagement() en post_scheduler.py. Es un KPI de
  // cuenta (una tarjeta por Pagina conectada, no un total sumado), igual
  // criterio del plan que "Seguidores totales" -- por eso no se suma entre
  // cuentas como el resto de esta seccion. Instagram-only en el selector
  // no debe mostrarlo (mismo criterio que igAccounts al reves).
  const fbAccounts = platform === 'instagram' ? [] : (fbAccountsRaw || []);
  const fbEngagementCards = fbAccounts.map(acc => {
    const row = Array.isArray(acc.socialbot_audience_reach) ? acc.socialbot_audience_reach[0] : acc.socialbot_audience_reach;
    if(!row || row.page_engagement == null) return null;
    return { name: acc.page_name, value: row.page_engagement };
  }).filter(Boolean);

  // Actualización 03/08/2026 (actualizacion_posts_y_metricas.txt, Parte 2):
  // demográficos de audiencia -- se combinan Instagram y Facebook segun el
  // selector de plataforma (mismo criterio que igAccounts/fbAccounts de
  // arriba), sumando entre cuentas por si hay mas de una del mismo tipo.
  // gender_age en la práctica solo va a tener datos de Instagram (Facebook
  // no manda esa columna -- ver nota en collect_audience_demographics(),
  // metrics_collector.py); country/city sí combinan ambas plataformas.
  const demoAccounts = (demographicsAccountsRaw || []).filter(acc => platform === 'all' || acc.platform === platform);
  const demoTotals = { gender_age: {}, country: {}, city: {} };
  demoAccounts.forEach(acc => {
    (acc.socialbot_audience_demographics || []).forEach(row => {
      const bucket = demoTotals[row.breakdown_type];
      if(!bucket) return;
      bucket[row.breakdown_key] = (bucket[row.breakdown_key] || 0) + Number(row.value || 0);
    });
  });
  // Género: sumamos el primer componente de la clave 'GENERO.EDAD' (ej.
  // 'F.35-44' -> 'F'). Meta usa 'F'/'M'/'U' (mujer/hombre/no especificado).
  const GENDER_LABELS = { F: 'Mujeres', M: 'Hombres', U: 'No especificado' };
  const genderTotals = {};
  Object.entries(demoTotals.gender_age).forEach(([key, value]) => {
    const gender = key.split('.')[0];
    genderTotals[gender] = (genderTotals[gender] || 0) + value;
  });
  const genderGrandTotal = Object.values(genderTotals).reduce((s, v) => s + v, 0);
  const genderRows = Object.entries(genderTotals)
    .map(([gender, value]) => ({ gender, label: GENDER_LABELS[gender] || gender, value, pct: genderGrandTotal ? Math.round((value / genderGrandTotal) * 100) : 0 }))
    .sort((a, b) => b.value - a.value);
  // Franja etaria: agrupamos por el segundo componente de la clave (ej.
  // 'F.35-44' -> '35-44'), con doble barra mujeres/hombres si Meta separa
  // por género (que es como llega hoy). Orden fijo (no alfabético) para
  // que las franjas queden de menor a mayor edad.
  const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
  const ageBuckets = {};
  Object.entries(demoTotals.gender_age).forEach(([key, value]) => {
    const [gender, age] = key.split('.');
    if(!ageBuckets[age]) ageBuckets[age] = { F: 0, M: 0, U: 0 };
    ageBuckets[age][gender] = (ageBuckets[age][gender] || 0) + value;
  });
  const ageRows = Object.keys(ageBuckets)
    .sort((a, b) => AGE_ORDER.indexOf(a) - AGE_ORDER.indexOf(b))
    .map(age => ({ age, ...ageBuckets[age], total: ageBuckets[age].F + ageBuckets[age].M + ageBuckets[age].U }));
  const ageGrandTotal = ageRows.reduce((s, r) => s + r.total, 0);
  const hasGenderAgeData = genderGrandTotal > 0;
  // Principales ubicaciones: top 5 de país o ciudad segun el toggle
  // (metricLocationView, por defecto 'country'). % sobre el total de ESE
  // breakdown (no sobre seguidores totales -- Meta solo devuelve el top 45,
  // así que el % ya es "sobre lo que Meta reportó", no sobre el 100% real
  // si hay muchas ubicaciones chicas fuera del top 45).
  const locationView = metricLocationView[clientId] || 'country';
  const locationTotals = demoTotals[locationView] || {};
  const locationGrandTotal = Object.values(locationTotals).reduce((s, v) => s + v, 0);
  const locationRows = Object.entries(locationTotals)
    .map(([key, value]) => ({ key, value, pct: locationGrandTotal ? Math.round((value / locationGrandTotal) * 100) : 0 }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
  const hasLocationData = locationRows.length > 0;
  const hasAnyDemographics = hasGenderAgeData || hasLocationData;

  // Seguidores/fans totales por cuenta + variacion vs. hace 7 dias (ver
  // collect_follower_snapshots() en post_scheduler.py). Agrupamos los
  // snapshots (ya vienen ordenados por fecha ascendente) por cuenta, y para
  // cada una buscamos el ultimo valor y el snapshot mas cercano a 7 dias
  // antes de ese ultimo (no necesariamente exacto -- puede faltar algun
  // dia si el scheduler no corrio o la cuenta se conecto hace poco).
  const snapshotsByAccount = {};
  (followerSnapshotsRaw || []).forEach(row => {
    const acc = row.socialbot_social_accounts;
    if(!acc) return;
    if(!snapshotsByAccount[row.social_account_id]) snapshotsByAccount[row.social_account_id] = { platform: acc.platform, name: acc.page_name, snaps: [] };
    snapshotsByAccount[row.social_account_id].snaps.push({ date: row.snapshot_date, count: row.follower_count });
  });
  // Actualizacion 06/08/2026: % de crecimiento de seguidores en los ultimos
  // 28 dias -- el dato que Meta muestra en su propio Insights ("creciste X%
  // este mes") y que hasta ahora no existia ni en agencia ni en cliente.
  // Reutiliza el mismo historial diario (followerSnapshotsRaw) que ya se
  // pedia para "Seguidores totales" / delta semanal -- no hace falta
  // ninguna query nueva, solo se agrega, por cuenta, la muestra mas cercana
  // a 28 dias antes de la ultima, ademas de la de 7 dias que ya existia.
  const followerCards = Object.values(snapshotsByAccount).map(acc => {
    const snaps = acc.snaps.filter(s => s.count != null);
    if(!snaps.length) return null;
    const latest = snaps[snaps.length - 1];
    const targetDate = new Date(latest.date);
    targetDate.setDate(targetDate.getDate() - 7);
    let weekAgo = null;
    for(const s of snaps){
      if(new Date(s.date) <= targetDate) weekAgo = s; // se queda con el ultimo que cumple, o sea el mas cercano a 7 dias atras
    }
    const target28 = new Date(latest.date);
    target28.setDate(target28.getDate() - 28);
    let base28 = null;
    for(const s of snaps){
      if(new Date(s.date) <= target28) base28 = s;
    }
    return { platform: acc.platform, name: acc.name, count: latest.count, delta: weekAgo ? latest.count - weekAgo.count : null, base28: base28 ? base28.count : null };
  }).filter(Boolean).filter(f => platform === 'all' || f.platform === platform);
  // Se suma entre todas las cuentas visibles (respeta el selector de
  // plataforma, igual que followerCards). Cuentas sin 28 dias de historial
  // todavia (recien conectadas) se excluyen del calculo por completo, en
  // vez de arruinar el numero con un 0 que en realidad es "sin dato".
  const growthAccounts = followerCards.filter(f => f.base28 !== null);
  const growthLatestSum = growthAccounts.reduce((s, f) => s + f.count, 0);
  const growthBaseSum = growthAccounts.reduce((s, f) => s + f.base28, 0);
  const hasGrowthData = growthAccounts.length > 0;
  const growthIsNew = hasGrowthData && growthBaseSum === 0 && growthLatestSum > 0;
  const growthPct = (hasGrowthData && growthBaseSum > 0) ? Math.round(((growthLatestSum - growthBaseSum) / growthBaseSum) * 1000) / 10 : null;

  const el = document.getElementById(`metrics-${clientId}`);
  if(!el) return;
  el.innerHTML = `
    <div class="period-toggle" style="justify-content:space-between; flex-wrap:wrap; gap:8px;">
      <div style="display:flex; gap:6px;">
        <button class="${period==='week'?'active':''}" onclick="setMetricPeriod('${clientId}','week')">Semanal</button>
        <button class="${period==='month'?'active':''}" onclick="setMetricPeriod('${clientId}','month')">Mensual</button>
      </div>
      <select onchange="setMetricPlatform('${clientId}', this.value)" style="width:auto;">
        <option value="all" ${platform==='all'?'selected':''}>Todas las plataformas</option>
        <option value="facebook" ${platform==='facebook'?'selected':''}>📘 Facebook</option>
        <option value="instagram" ${platform==='instagram'?'selected':''}>📷 Instagram</option>
      </select>
    </div>
    ${hasGrowthData ? `
    <div class="card" style="text-align:center; padding:18px; margin-bottom:14px; border:1px solid var(--gold);">
      <div style="font-size:34px; font-weight:700; line-height:1.1; color:${growthIsNew || (growthPct !== null && growthPct >= 0) ? '#5fae6a' : 'var(--warn)'};">
        ${growthIsNew ? 'nuevo' : (growthPct === null ? '—' : `${growthPct >= 0 ? '+' : ''}${growthPct}%`)}
      </div>
      <div class="kpi-label" style="margin-top:4px;">📈 Crecimiento de seguidores (últimos 28 días)</div>
    </div>
    ` : ''}
    <div class="meta-row" style="margin-top:0; margin-bottom:8px;">Totales de ${windowLabel}:</div>
    <div class="kpi-row kpi-row-5">
      <div class="kpi-card"><div class="kpi-value">${totalLeads}${pctDeltaBadge(totalLeads, prevTotalLeads, latestRowDateLabel(leadsRows, 'created_at'))}</div><div class="kpi-label">📩 Consultas recibidas</div></div>
      <div class="kpi-card"><div class="kpi-value">${totalConverted}${pctDeltaBadge(totalConverted, prevTotalConverted, latestRowDateLabel(leadsRows.filter(r => r.status === 'convertido'), 'created_at'))}</div><div class="kpi-label">🤝 Clientes nuevos</div></div>
      <div class="kpi-card"><div class="kpi-value">${totalLikes}${pctDeltaBadge(totalLikes, prevTotalLikes, latestRowDateLabel(postsRows, 'published_at'))}</div><div class="kpi-label">❤️ Me gusta</div></div>
      <div class="kpi-card"><div class="kpi-value">${postsWithReach.length ? totalReach : '—'}${postsWithReach.length ? pctDeltaBadge(totalReach, prevTotalReach, latestRowDateLabel(postsWithReach, 'published_at')) : ''}</div><div class="kpi-label">👁️ Alcance real${postsWithReach.length < postsRows.length ? ' *' : ''}</div></div>
      <div class="kpi-card"><div class="kpi-value">${avgResponseLabel}</div><div class="kpi-label">⏱️ Min. resp. promedio</div></div>
    </div>
    <div class="meta-row" style="margin-top:-6px; font-size:11px;">vs. periodo anterior (${windowLabel === 'últimas 8 semanas' ? 'las 8 semanas previas' : 'los 6 meses previos'})</div>
    ${postsWithReach.length < postsRows.length ? `<div class="meta-row" style="margin-top:-6px; font-size:11px;">* ${postsRows.length - postsWithReach.length} de ${postsRows.length} posts todavía sin dato de alcance (Meta tarda unos días en calcularlo, o es reciente).</div>` : ''}
    ${topPost ? `
    <div class="card" style="display:flex; gap:12px; align-items:flex-start; margin-bottom:14px;">
      <div style="font-size:28px; line-height:1;">🏆</div>
      <div style="flex:1; min-width:0;">
        <div class="metric-title" style="margin:0 0 4px;">Post destacado (${windowLabel})</div>
        <div style="font-size:13px; color:var(--muted); margin-bottom:6px;">
          ${topPost.platform === 'instagram' ? '📸 Instagram' : '📘 Facebook'}${topPost.media_type === 'video' ? ' · 🎬 Video/Reel' : ''}
          ${topPost.caption ? ' — ' + topPost.caption.slice(0, 100) + (topPost.caption.length > 100 ? '...' : '') : ''}
        </div>
        <div style="display:flex; gap:14px; flex-wrap:wrap; font-size:13px;">
          <span>❤️ ${topPost.likes}</span>
          <span>💬 ${topPost.comments}</span>
          ${topPost.platform === 'facebook' ? `<span>🔁 ${topPost.shares}</span>` : ''}
          ${topPost.saved !== null ? `<span>🔖 ${topPost.saved}</span>` : ''}
          ${topPost.reach !== null ? `<span>👁️ ${topPost.reach}</span>` : ''}
          ${topPost.plays !== null ? `<span>▶️ ${topPost.plays}</span>` : ''}
        </div>
        ${topPost.permalink_url ? `<a href="${topPost.permalink_url}" target="_blank" rel="noopener" style="font-size:12px;">Ver publicación original ↗</a>` : ''}
      </div>
    </div>
    ` : ''}
    <div class="meta-row" style="margin-top:0; margin-bottom:8px;">Interacción en publicaciones (${windowLabel}):</div>
    <div class="kpi-row">
      <div class="kpi-card" style="cursor:pointer;" onclick="openCommentsModal('${clientId}', '${platform}')"><div class="kpi-value">${totalComments}${lastActivitySuffix(commentInteractionsRows, 'created_at')}</div><div class="kpi-label">💬 Comentarios</div></div>
      ${platform === 'instagram' ? `<div class="kpi-card"><div class="kpi-value">—</div><div class="kpi-label">🔁 Compartidos<br><span style="font-size:10px; font-weight:400;">Instagram no lo reporta vía API</span></div></div>` : `<div class="kpi-card"><div class="kpi-value">${totalShares}${lastActivitySuffix(postsRows.filter(p => p.shares > 0), 'published_at')}</div><div class="kpi-label">🔁 Compartidos</div></div>`}
      ${platform === 'facebook' ? `<div class="kpi-card"><div class="kpi-value">—</div><div class="kpi-label">🔖 Guardados<br><span style="font-size:10px; font-weight:400;">Solo existe para Instagram</span></div></div>` : `<div class="kpi-card"><div class="kpi-value">${postsWithSaved.length ? totalSaved : '—'}${postsWithSaved.length ? lastActivitySuffix(postsWithSaved.filter(p => p.saved > 0), 'published_at') : ''}</div><div class="kpi-label">🔖 Guardados (Instagram)</div></div>`}
    </div>
    ${platform !== 'facebook' && postsWithPlays.length ? `
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-value">${totalPlays.toLocaleString('es')}${lastActivitySuffix(postsWithPlays.filter(p => p.plays > 0), 'published_at')}</div><div class="kpi-label">▶️ Reproducciones (Reels)</div></div>
      <div class="kpi-card"><div class="kpi-value">${avgWatchTimeSeconds}s</div><div class="kpi-label">⏱️ Duración promedio vista</div></div>
    </div>
    ` : ''}
    ${followerCards.length ? `
    <div class="metric-title">Seguidores totales</div>
    <div class="kpi-row" style="grid-template-columns:repeat(${Math.min(followerCards.length, 3)}, 1fr);">
      ${followerCards.map(f => `
        <div class="kpi-card">
          <div class="kpi-value">${f.count.toLocaleString('es')}</div>
          <div class="kpi-label">${f.platform === 'instagram' ? '📸' : '📘'} ${f.name || (f.platform === 'instagram' ? 'Instagram' : 'Facebook')}${f.delta !== null ? ` · ${f.delta >= 0 ? '+' : ''}${f.delta} esta semana` : ''}</div>
        </div>
      `).join('')}
    </div>
    ` : ''}
    <div class="meta-row" style="margin-top:0; margin-bottom:8px;">🔗 Clics al link (${totalClicks} en total, ${windowLabel}):</div>
    <div class="kpi-row kpi-row-4">
      <div class="kpi-card"><div class="kpi-value">${clicksBySource.comment_reply}${lastActivitySuffix(linkClicksRows.filter(c => c.source === 'comment_reply'), 'clicked_at')}</div><div class="kpi-label">💬 Comentarios</div></div>
      <div class="kpi-card"><div class="kpi-value">${clicksBySource.dm_reply}${lastActivitySuffix(linkClicksRows.filter(c => c.source === 'dm_reply'), 'clicked_at')}</div><div class="kpi-label">✉️ Mensajes directos</div></div>
      <div class="kpi-card"><div class="kpi-value">${clicksBySource.ai_reply}${lastActivitySuffix(linkClicksRows.filter(c => c.source === 'ai_reply'), 'clicked_at')}</div><div class="kpi-label">🤖 Respuesta IA</div></div>
      <div class="kpi-card"><div class="kpi-value">${clicksBySource.fallback_reply}${lastActivitySuffix(linkClicksRows.filter(c => c.source === 'fallback_reply'), 'clicked_at')}</div><div class="kpi-label">🔤 Palabra clave</div></div>
    </div>
    ${igAccounts.length ? `
    <div class="metric-title">Audiencia de Instagram: seguidores vs. no seguidores (últimos 28 días)</div>
    ${hasAudienceData || hasProfileViewsData || hasEngagedData ? `
    <div style="display:flex; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
      ${hasAudienceData ? `
      <div class="kpi-card" style="flex:1; min-width:120px;"><div class="kpi-value">${followerPct}%</div><div class="kpi-label">👥 Seguidores</div></div>
      <div class="kpi-card" style="flex:1; min-width:120px;"><div class="kpi-value">${nonFollowerPct}%</div><div class="kpi-label">🌐 No seguidores</div></div>
      ` : ''}
      ${hasProfileViewsData ? `<div class="kpi-card" style="flex:1; min-width:120px;"><div class="kpi-value">${totalProfileViews.toLocaleString('es')}</div><div class="kpi-label">🔎 Visitas al perfil</div></div>` : ''}
      ${engagementRate !== null ? `<div class="kpi-card" style="flex:1; min-width:120px;"><div class="kpi-value">${engagementRate}%${prevAvgEngagementRate !== null ? pctDeltaBadge(engagementRate, prevAvgEngagementRate) : ''}</div><div class="kpi-label">📈 Engagement real (s/alcance)</div></div>` : ''}
    </div>
    ${hasAudienceData ? `
    <div style="height:8px; border-radius:99px; overflow:hidden; display:flex; margin-bottom:6px;">
      <div style="height:100%; width:${followerPct}%; background:var(--gold);"></div>
      <div style="height:100%; width:${nonFollowerPct}%; background:var(--line);"></div>
    </div>
    <div class="meta-row" style="font-size:11px; margin-bottom:14px;">Alcance total de la cuenta en el periodo: ${totalAudienceReach.toLocaleString('es')} cuentas.</div>
    ` : ''}
    ${hasOnlineFollowersData ? `
    <div class="metric-title" style="margin-top:4px;">🕒 Horario en que tu audiencia está más conectada (promedio últimos 7 días)</div>
    <div class="chart-wrap" style="align-items:flex-end;">
      ${onlineByHour.map((count, hour) => {
        const max = Math.max(1, ...onlineByHour);
        const h = Math.max(3, (count / max) * 60);
        const isTop = topHours.some(t => t.hour === hour);
        return `
          <div class="chart-bar-col">
            <div class="chart-bar" style="height:${h}px; ${isTop ? 'background:var(--gold);' : ''}" title="${hour}hs: ${count}"></div>
            <div class="chart-label" style="${isTop ? 'color:var(--gold); font-weight:600;' : ''}">${hour}</div>
          </div>`;
      }).join('')}
    </div>
    ${topHours.length ? `<div class="meta-row" style="font-size:11px; margin-bottom:14px;">Mejores horarios sugeridos para publicar: ${topHours.map(t => `${t.hour}hs`).join(', ')} (ver pestaña "Horarios").</div>` : ''}
    ` : ''}
    ` : `<div class="meta-row" style="font-size:12px; margin-bottom:14px;">Todavía no hay datos de audiencia para esta cuenta (Meta puede tardar unos días en tenerlos disponibles, o recién se conectó).</div>`}
    ` : ''}
    ${fbEngagementCards.length ? `
    <div class="metric-title">Audiencia de Facebook: engagement de página (últimos 28 días)</div>
    <div class="kpi-row" style="grid-template-columns:repeat(${Math.min(fbEngagementCards.length, 3)}, 1fr);">
      ${fbEngagementCards.map(f => `
        <div class="kpi-card">
          <div class="kpi-value">${f.value.toLocaleString('es')}</div>
          <div class="kpi-label">📘 ${f.name || 'Facebook'} · engagement total</div>
        </div>
      `).join('')}
    </div>
    ` : ''}
    ${hasAnyDemographics ? `
    <div class="metric-title">Demográficos de audiencia</div>
    ${hasGenderAgeData ? `
    <div class="meta-row" style="margin-bottom:6px;">Género</div>
    <div style="margin-bottom:14px;">
      ${genderRows.map(g => `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
          <div style="width:110px; font-size:12px; color:var(--muted);">${g.label}</div>
          <div style="flex:1; height:10px; border-radius:99px; overflow:hidden; background:var(--line);">
            <div style="height:100%; width:${g.pct}%; background:var(--gold);"></div>
          </div>
          <div style="width:40px; text-align:right; font-size:12px; font-weight:600;">${g.pct}%</div>
        </div>
      `).join('')}
    </div>
    <div class="meta-row" style="margin-bottom:6px;">Franja etaria</div>
    <div class="chart-wrap" style="align-items:flex-end; margin-bottom:6px;">
      ${ageRows.map(r => {
        const max = Math.max(1, ...ageRows.map(x => x.total));
        const hF = Math.max(0, (r.F / max) * 60);
        const hM = Math.max(0, (r.M / max) * 60);
        return `
          <div class="chart-bar-col">
            <div style="display:flex; gap:2px; align-items:flex-end;">
              <div style="width:8px; height:${hF}px; background:var(--gold);" title="Mujeres ${r.age}: ${r.F}"></div>
              <div style="width:8px; height:${hM}px; background:var(--line);" title="Hombres ${r.age}: ${r.M}"></div>
            </div>
            <div class="chart-label">${r.age}</div>
          </div>`;
      }).join('')}
    </div>
    <div class="meta-row" style="font-size:11px; margin-bottom:14px;">🟡 Mujeres · ⚪ Hombres · ${ageGrandTotal.toLocaleString('es')} seguidores con dato de edad.</div>
    ` : `<div class="meta-row" style="font-size:12px; margin-bottom:14px;">Todavía no hay datos de género/edad para esta cuenta (solo disponible para Instagram; Meta dejó de dar este dato para Páginas de Facebook en 2024).</div>`}
    ${hasLocationData ? `
    <div class="meta-row" style="margin-bottom:6px; display:flex; align-items:center; justify-content:space-between;">
      <span>Principales ubicaciones</span>
      <span class="period-toggle">
        <button type="button" class="${locationView==='country'?'active':''}" style="padding:2px 8px; font-size:11px;" onclick="setMetricLocationView('${clientId}', 'country')">Países</button>
        <button type="button" class="${locationView==='city'?'active':''}" style="padding:2px 8px; font-size:11px;" onclick="setMetricLocationView('${clientId}', 'city')">Ciudades</button>
      </span>
    </div>
    <div style="margin-bottom:14px;">
      ${locationRows.map(l => `
        <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
          <div style="width:110px; font-size:12px; color:var(--muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${l.key}</div>
          <div style="flex:1; height:10px; border-radius:99px; overflow:hidden; background:var(--line);">
            <div style="height:100%; width:${l.pct}%; background:var(--gold);"></div>
          </div>
          <div style="width:40px; text-align:right; font-size:12px; font-weight:600;">${l.pct}%</div>
        </div>
      `).join('')}
    </div>
    ` : ''}
    ` : ''}
    <div class="metric-title">Consultas recibidas</div>
    <div id="chartLeads-${clientId}"></div>
    <div class="metric-title">Clientes nuevos (convertidos)</div>
    <div id="chartConverted-${clientId}"></div>
    <div class="metric-title">Me gusta en publicaciones</div>
    <div id="chartLikes-${clientId}"></div>
    <div class="metric-title">Alcance real (reach)</div>
    <div id="chartReach-${clientId}"></div>
    <div class="metric-title">Posts publicados</div>
    <div id="chartPosts-${clientId}"></div>
    <div class="metric-title">Tasa de respuesta automática (%)</div>
    <div id="chartReplyRate-${clientId}"></div>
  `;
  renderBarChart(document.getElementById(`chartLeads-${clientId}`), leadsBuckets);
  renderBarChart(document.getElementById(`chartConverted-${clientId}`), convertedBuckets);
  renderBarChart(document.getElementById(`chartLikes-${clientId}`), likesBuckets, { sum: true });
  renderBarChart(document.getElementById(`chartReach-${clientId}`), reachBuckets, { sum: true });
  renderBarChart(document.getElementById(`chartPosts-${clientId}`), postsBuckets);
  renderBarChart(document.getElementById(`chartReplyRate-${clientId}`), replyBuckets, { rate: true });
}

// ---------------------------------------------------------------------------
// Popup de comentarios (card "💬 Comentarios" de Interaccion en
// publicaciones): lista los comentarios/DMs con su respuesta (si la hay),
// fecha y hora de cada uno, y el titulo del post al que pertenecen.
//
// Actualizacion 03/08/2026 (actualizacion_popup_comentarios.txt): el texto
// (comment_text/reply_text/external_post_id) solo existe para
// interacciones nuevas (migracion 0041) o traidas por el backfill
// (backfill-post-comments, matched_keyword='historico-import') -- las de
// antes de eso quedan en null y se muestran con una nota aclaratoria en
// vez de texto vacio.
//
// Actualizacion 04/08/2026: el link "Ver publicación" se movio a su propia
// linea (clase .comment-post-link) en vez de ir pegado al titulo del post
// -- cuando el titulo era largo, .comment-post-title lo recortaba junto
// con el texto (white-space:nowrap + text-overflow:ellipsis en el mismo
// div), asi que el link quedaba en el DOM pero invisible. Separandolo en
// su propio div ya no lo afecta ese recorte, sin importar el largo del
// titulo.
//
// Actualizacion 04/08/2026 (2): .comment-post-link tenia la clase puesta
// pero sin ningun CSS asociado (quedaba como link azul de navegador por
// defecto, sin relacion visual con el resto del panel). Se agrego el
// estilo en styles.css (badge dorado con icono) para que se note como
// elemento clickeable de verdad -- mismo criterio visual que el link de
// "Ver publicación en vivo" del post destacado (mas arriba en este archivo).
function escapeHtml(str){
  return String(str ?? '').replace(/[&<>"']/g, m => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
}
function formatDateTime(iso){
  if(!iso) return '';
  return new Date(iso).toLocaleString('es', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' });
}
async function openCommentsModal(clientId, platform = 'all'){
  const modal = document.getElementById('commentsModal');
  const body = document.getElementById('commentsModalBody');
  body.innerHTML = `<div class="meta-row">Cargando...</div>`;
  modal.classList.add('open');

  // Respeta el mismo filtro de plataforma elegido arriba (Todas/FB/IG) --
  // si no, el popup podia traer mas filas de las que decia el numero de
  // la card (ej. card en 3 por filtrar solo Instagram, popup trayendo
  // tambien las de Facebook).
  let query = sb.from('socialbot_interactions_log')
    .select('comment_text, reply_text, created_at, replied_at, external_post_id, platform, post_permalink_url')
    .eq('client_id', clientId)
    .eq('type', 'comment')
    .order('created_at', { ascending: false })
    .limit(200);
  if(platform !== 'all'){
    query = query.eq('platform', platform);
  }

  const [{ data: interactions, error: interactionsError }, { data: posts }] = await Promise.all([
    query,
    sb.from('socialbot_posts')
      .select('external_post_id, caption, platform, permalink_url')
      .eq('client_id', clientId)
      .not('external_post_id', 'is', null),
  ]);

  if(interactionsError){
    body.innerHTML = `<div class="meta-row">No se pudieron cargar los comentarios. Intentá de nuevo en un momento.</div>`;
    return;
  }

  const titleByPostId = {};
  // Punto pedido: link directo a la publicación desde cada comentario del
  // popup. Puede ser null si el post fue borrado del panel o si es un post
  // muy viejo de antes de que se guardara permalink_url (migracion 0025).
  const permalinkByPostId = {};
  (posts || []).forEach(p => {
    if(!p.external_post_id) return;
    titleByPostId[p.external_post_id] = p.caption ? p.caption.slice(0, 80) + (p.caption.length > 80 ? '...' : '') : null;
    permalinkByPostId[p.external_post_id] = p.permalink_url || null;
  });

  const rows = interactions || [];
  if(!rows.length){
    body.innerHTML = `<div class="meta-row">Todavía no hay comentarios registrados para este cliente.</div>`;
    return;
  }

  body.innerHTML = rows.map(r => {
    const postTitle = r.external_post_id ? (titleByPostId[r.external_post_id] || null) : null;
    const platformIcon = r.platform === 'instagram' ? '📸' : '📘';
    const platformLabel = r.platform === 'instagram' ? 'Instagram' : 'Facebook';
    const titleLine = postTitle
      ? `${platformIcon} ${platformLabel} — ${escapeHtml(postTitle)}`
      : (r.external_post_id ? `${platformIcon} ${platformLabel} — Publicación (sin título guardado)` : `${platformIcon} ${platformLabel} — Publicación no identificada`);
    // Link directo al post. Actualizacion 03/08/2026 (migracion 0042):
    // prioriza post_permalink_url, guardado por meta-webhook/index.ts en
    // el momento del comentario (pedido directo a la Graph API, no
    // depende de matchear con socialbot_posts). Fallback al cruce viejo
    // por external_post_id para comentarios registrados antes de esa
    // columna -- puede seguir sin link si el post no vive en
    // socialbot_posts o si su external_post_id tiene un sufijo pegado
    // (ej. "123 (foto manual)") que no matchea con el postId limpio.
    const permalink = r.post_permalink_url || (r.external_post_id ? permalinkByPostId[r.external_post_id] : null);
    // Actualizacion 04/08/2026: el link va en su propia linea (ver nota
    // arriba de la funcion) -- por eso ya no arranca con un espacio ni se
    // concatena al titulo.
    const postLink = permalink
      ? `<a href="${permalink}" target="_blank" rel="noopener" class="comment-post-link">Ver publicación<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a>`
      : '';
    const commentBody = r.comment_text
      ? escapeHtml(r.comment_text)
      : `<span style="font-style:italic; color:var(--muted);">Comentario anterior a esta función: no se guardó el texto original.</span>`;
    const replyBlock = r.reply_text
      ? `<div class="comment-reply">${escapeHtml(r.reply_text)}<div class="comment-reply-meta">Respondido ${formatDateTime(r.replied_at || r.created_at)}</div></div>`
      : `<div class="comment-no-reply">Sin respuesta registrada</div>`;
    return `
      <div class="comment-item">
        <div class="comment-post-title">${titleLine}</div>
        ${postLink}
        <div class="comment-text">${commentBody}</div>
        <div class="comment-meta">${formatDateTime(r.created_at)}</div>
        ${replyBlock}
      </div>
    `;
  }).join('');
}
function closeCommentsModal(){
  document.getElementById('commentsModal').classList.remove('open');
}

export { buildPeriodBuckets, closeCommentsModal, computeReportRange, fillBuckets, onReportPeriodChange, openCommentsModal, renderBarChart, renderHomeView, renderMetrics, sendReportNow, setMetricLocationView, setMetricPeriod, setMetricPlatform };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.closeCommentsModal = closeCommentsModal;
window.onReportPeriodChange = onReportPeriodChange;
window.openCommentsModal = openCommentsModal;
window.sendReportNow = sendReportNow;
window.setMetricLocationView = setMetricLocationView;
window.setMetricPeriod = setMetricPeriod;
window.setMetricPlatform = setMetricPlatform;