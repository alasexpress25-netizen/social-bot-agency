// js/metrics.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { PLATFORM_META_AG, metricPeriod, metricPlatform, sb } from "./state.js";
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

  const [{ data: leads }, { data: interactions }, { data: postsWithMetrics }, { data: linkClicks }, { data: igAccountsRaw }, { data: followerSnapshotsRaw }] = await Promise.all([
    sb.from('socialbot_leads').select('created_at, status, platform').eq('client_id', clientId).gte('created_at', windowStartIso),
    sb.from('socialbot_interactions_log').select('created_at, replied, replied_at, platform').eq('client_id', clientId).gte('created_at', windowStartIso),
    sb.from('socialbot_posts').select('published_at, platform, external_post_id, socialbot_post_metrics(likes, comments, shares, reach, saved)').eq('client_id', clientId).eq('status', 'published').gte('published_at', windowStartIso),
    sb.from('socialbot_link_clicks').select('source, clicked_at, external_post_id').eq('client_id', clientId).gte('clicked_at', windowStartIso),
    // Alcance de cuenta (no por post, no depende del periodo semanal/mensual
    // de arriba) desglosado seguidor/no-seguidor -- ver
    // collect_audience_reach() en post_scheduler.py. Solo se guarda el
    // ultimo snapshot por cuenta, así que no hace falta filtrar por fecha.
    sb.from('socialbot_social_accounts').select('platform, socialbot_audience_reach(follower_reach, non_follower_reach, profile_views, period, fetched_at)').eq('client_id', clientId).eq('platform', 'instagram'),
    // Historial de seguidores/fans totales (todas las plataformas) -- ver
    // collect_follower_snapshots() en post_scheduler.py. Tampoco depende
    // del periodo de arriba: se pide todo el historial guardado (como
    // mucho 1 fila por cuenta por dia) y se calcula la variacion semanal
    // aca abajo, comparando el ultimo contra el mas cercano a 7 dias atras.
    sb.from('socialbot_follower_snapshots').select('social_account_id, follower_count, snapshot_date, socialbot_social_accounts!inner(platform, page_name, client_id)').eq('socialbot_social_accounts.client_id', clientId).order('snapshot_date', { ascending: true }),
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
  const totalComments = postsRows.reduce((s, p) => s + p.comments, 0);
  const totalShares = postsRows.reduce((s, p) => s + p.shares, 0);
  const totalReach = postsWithReach.reduce((s, p) => s + p.reach, 0);
  // 'saved' solo aplica a Instagram -- igual que con reach, separamos
  // cuantos posts tienen el dato realmente (no todos son de Instagram, y a
  // los de Facebook ese campo directamente no les corresponde).
  const postsWithSaved = postsRows.filter(p => p.saved !== null);
  const totalSaved = postsWithSaved.reduce((s, p) => s + p.saved, 0);
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
  });
  const totalAudienceReach = followerReach + nonFollowerReach;
  const followerPct = totalAudienceReach ? Math.round((followerReach / totalAudienceReach) * 100) : null;
  const nonFollowerPct = followerPct === null ? null : 100 - followerPct;

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
    return { platform: acc.platform, name: acc.name, count: latest.count, delta: weekAgo ? latest.count - weekAgo.count : null };
  }).filter(Boolean).filter(f => platform === 'all' || f.platform === platform);

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
    <div class="meta-row" style="margin-top:0; margin-bottom:8px;">Totales de ${windowLabel}:</div>
    <div class="kpi-row kpi-row-5">
      <div class="kpi-card"><div class="kpi-value">${totalLeads}</div><div class="kpi-label">📩 Consultas recibidas</div></div>
      <div class="kpi-card"><div class="kpi-value">${totalConverted}</div><div class="kpi-label">🤝 Clientes nuevos</div></div>
      <div class="kpi-card"><div class="kpi-value">${totalLikes}</div><div class="kpi-label">❤️ Me gusta</div></div>
      <div class="kpi-card"><div class="kpi-value">${postsWithReach.length ? totalReach : '—'}</div><div class="kpi-label">👁️ Alcance real${postsWithReach.length < postsRows.length ? ' *' : ''}</div></div>
      <div class="kpi-card"><div class="kpi-value">${avgResponseLabel}</div><div class="kpi-label">⏱️ Min. resp. promedio</div></div>
    </div>
    ${postsWithReach.length < postsRows.length ? `<div class="meta-row" style="margin-top:-6px; font-size:11px;">* ${postsRows.length - postsWithReach.length} de ${postsRows.length} posts todavía sin dato de alcance (Meta tarda unos días en calcularlo, o es reciente).</div>` : ''}
    <div class="meta-row" style="margin-top:0; margin-bottom:8px;">Interacción en publicaciones (${windowLabel}):</div>
    <div class="kpi-row">
      <div class="kpi-card"><div class="kpi-value">${totalComments}</div><div class="kpi-label">💬 Comentarios</div></div>
      ${platform === 'instagram' ? `<div class="kpi-card"><div class="kpi-value">—</div><div class="kpi-label">🔁 Compartidos<br><span style="font-size:10px; font-weight:400;">Instagram no lo reporta vía API</span></div></div>` : `<div class="kpi-card"><div class="kpi-value">${totalShares}</div><div class="kpi-label">🔁 Compartidos</div></div>`}
      ${platform === 'facebook' ? `<div class="kpi-card"><div class="kpi-value">—</div><div class="kpi-label">🔖 Guardados<br><span style="font-size:10px; font-weight:400;">Solo existe para Instagram</span></div></div>` : `<div class="kpi-card"><div class="kpi-value">${postsWithSaved.length ? totalSaved : '—'}</div><div class="kpi-label">🔖 Guardados (Instagram)</div></div>`}
    </div>
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
      <div class="kpi-card"><div class="kpi-value">${clicksBySource.comment_reply}</div><div class="kpi-label">💬 Comentarios</div></div>
      <div class="kpi-card"><div class="kpi-value">${clicksBySource.dm_reply}</div><div class="kpi-label">✉️ Mensajes directos</div></div>
      <div class="kpi-card"><div class="kpi-value">${clicksBySource.ai_reply}</div><div class="kpi-label">🤖 Respuesta IA</div></div>
      <div class="kpi-card"><div class="kpi-value">${clicksBySource.fallback_reply}</div><div class="kpi-label">🔤 Palabra clave</div></div>
    </div>
    ${igAccounts.length ? `
    <div class="metric-title">Audiencia de Instagram: seguidores vs. no seguidores (últimos 28 días)</div>
    ${hasAudienceData || hasProfileViewsData ? `
    <div style="display:flex; gap:10px; margin-bottom:6px; flex-wrap:wrap;">
      ${hasAudienceData ? `
      <div class="kpi-card" style="flex:1; min-width:120px;"><div class="kpi-value">${followerPct}%</div><div class="kpi-label">👥 Seguidores</div></div>
      <div class="kpi-card" style="flex:1; min-width:120px;"><div class="kpi-value">${nonFollowerPct}%</div><div class="kpi-label">🌐 No seguidores</div></div>
      ` : ''}
      ${hasProfileViewsData ? `<div class="kpi-card" style="flex:1; min-width:120px;"><div class="kpi-value">${totalProfileViews.toLocaleString('es')}</div><div class="kpi-label">🔎 Visitas al perfil</div></div>` : ''}
    </div>
    ${hasAudienceData ? `
    <div style="height:8px; border-radius:99px; overflow:hidden; display:flex; margin-bottom:6px;">
      <div style="height:100%; width:${followerPct}%; background:var(--gold);"></div>
      <div style="height:100%; width:${nonFollowerPct}%; background:var(--line);"></div>
    </div>
    <div class="meta-row" style="font-size:11px; margin-bottom:14px;">Alcance total de la cuenta en el periodo: ${totalAudienceReach.toLocaleString('es')} cuentas.</div>
    ` : ''}
    ` : `<div class="meta-row" style="font-size:12px; margin-bottom:14px;">Todavía no hay datos de audiencia para esta cuenta (Meta puede tardar unos días en tenerlos disponibles, o recién se conectó).</div>`}
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

export { buildPeriodBuckets, computeReportRange, fillBuckets, onReportPeriodChange, renderBarChart, renderHomeView, renderMetrics, sendReportNow, setMetricPeriod, setMetricPlatform };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.onReportPeriodChange = onReportPeriodChange;
window.sendReportNow = sendReportNow;
window.setMetricPeriod = setMetricPeriod;
window.setMetricPlatform = setMetricPlatform;
