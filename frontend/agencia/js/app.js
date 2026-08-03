// js/app.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { _WEEKDAY_NAMES_ES_JS, clientsCache, persistSelectedClientId, planViewMode, sb, selectedClientId, setCurrentAgencyId, setSelectedClientId } from "./state.js";
import { normalizeUrl, parseLeadStage } from "./utils.js";
import { updateClientesBadge, updateLeadsBadge, updatePlanBadge, updateQuejasBadge, updateReferidosBadge } from "./badges.js";
import { hashtagEditorHtml, hashtagsToArray, renderHashtagChips } from "./hashtags.js";
import { applyClientFilter } from "./ui-chrome.js";
import { updateArchivosHostStorageBadge } from "./archivos-host.js";
import { renderHomeView, renderMetrics } from "./metrics.js";
import { loadClientHealth } from "./client-health.js";
import { buildPlanCalendarHtml } from "./content-plan.js";
import { renderPostsList } from "./posts.js";
// Los siguientes imports son por efecto lateral: cada uno de estos
// archivos termina con window.funcion = funcion para exponer sus
// funciones a los onclick="..." generados en el HTML (inline y via
// innerHTML). Sin importarlos aca, esas funciones quedan "not defined"
// apenas se los llama, aunque el archivo exista y este bien escrito.
import "./auth.js";     // login, logout, signup
import "./clients.js";  // createClient, saveAccount, openEditClientModal, etc.
import "./leads.js";    // approveReferralSuggestion, rejectReferralSuggestion, updateLeadStatus, etc.
import "./media.js";    // addMedia, deleteMedia, updateMedia, toggleMediaTypeFields
import "./reviews.js";  // setReviewStatus, copyReviewReply, openSuccessStory
import "./rules.js";    // addRule, deleteRule, saveAi, updateRule
import "./schedule.js"; // addSlot, deleteSlot, saveAllSlots, useSuggestedSlot

async function boot(){
  const { data: { session } } = await sb.auth.getSession();
  if(!session){ return; }

  document.getElementById('authBox').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('userTag').innerText = session.user.email;

  // Buscar o crear la agencia del usuario logueado
  let { data: agencies } = await sb.from('socialbot_agencies').select('*').eq('owner_user_id', session.user.id);
  if(!agencies || agencies.length === 0){
    const name = prompt("Nombre de tu agencia:") || "Mi Agencia";
    const { data: created } = await sb.from('socialbot_agencies').insert({ owner_user_id: session.user.id, name }).select();
    agencies = created;
  }
  setCurrentAgencyId(agencies[0].id);
  loadClients();
}
async function loadClients(){
  const { data: clients } = await sb.from('socialbot_clients').select('*').order('created_at', { ascending:false });
  const container = document.getElementById('clientsList');
  container.innerHTML = '';
  const planContainer = document.getElementById('planList'); planContainer.innerHTML = '';
  const iaContainer = document.getElementById('iaList'); iaContainer.innerHTML = '';
  const horariosContainer = document.getElementById('horariosList'); horariosContainer.innerHTML = '';
  const mediosContainer = document.getElementById('mediosList'); mediosContainer.innerHTML = '';
  const autorespContainer = document.getElementById('autorespList'); autorespContainer.innerHTML = '';
  const postsContainer = document.getElementById('postsListAll'); postsContainer.innerHTML = '';
  const metricasContainer = document.getElementById('metricasList'); metricasContainer.innerHTML = '';
  const leadsContainer = document.getElementById('leadsList'); leadsContainer.innerHTML = '';
  const referidosContainer = document.getElementById('referidosList'); referidosContainer.innerHTML = '';
  const reviewsContainer = document.getElementById('reviewsList'); reviewsContainer.innerHTML = '';

  // Armamos el selector de clientes de la topbar, preservando la selección
  // actual si ese cliente todavía existe. Ya no hay opción "Todos los
  // clientes": si no hay nada elegido (primera carga) o el elegido ya no
  // existe, se cae al primero de la lista.
  const selector = document.getElementById('clientSelector');
  const stillExists = (clients||[]).some(c => c.id === selectedClientId);
  if(!stillExists){
    setSelectedClientId((clients && clients[0]) ? clients[0].id : null);
    persistSelectedClientId();
  }
  selector.innerHTML = (clients||[]).length
    ? (clients||[]).map(c => `<option value="${c.id}" ${c.id === selectedClientId ? 'selected' : ''}>${c.name}</option>`).join('')
    : '<option value="">Sin clientes todavía</option>';
  if(selectedClientId) selector.value = selectedClientId;

  // Los badges dependen del cliente elegido, así que se piden recién acá,
  // una vez que selectedClientId quedó resuelto arriba (no antes).
  updateLeadsBadge();
  updatePlanBadge();
  updateClientesBadge();
  updateReferidosBadge();
  updateQuejasBadge();
  loadClientHealth(clients);

  // A partir de acá, todo lo pesado (cuentas, IA, horarios, medios, reglas,
  // posts, leads, plan de contenido, reseñas) se pide y se renderiza SOLO
  // para el cliente elegido en el selector — antes se traía y armaba esto
  // mismo para todos los clientes de una, y se ocultaba con CSS el resto.
  const c = (clients||[]).find(cl => cl.id === selectedClientId);
  if(c){
    const { data: accounts } = await sb.from('socialbot_social_accounts').select('*').eq('client_id', c.id);
    const { data: aiRows } = await sb.from('socialbot_ai_settings').select('*').eq('client_id', c.id);
    const { data: slots } = await sb.from('socialbot_schedule_slots').select('*').eq('client_id', c.id).order('hour');
    const { data: suggestedSchedule } = await sb.from('socialbot_suggested_schedule').select('*').eq('client_id', c.id).order('avg_score', { ascending: false });
    // Punto 15 (propuestas-30-07-2026.md): ranking de ganchos ganadores ya
    // calculado por content_planner.py (punto 4) pero solo usado dentro
    // del prompt de la IA -- se persiste en socialbot_hook_type_ranking
    // para poder mostrarlo acá.
    const { data: hookTypeRanking } = await sb.from('socialbot_hook_type_ranking').select('*').eq('client_id', c.id).order('avg_score', { ascending: false });
    const { data: media } = await sb.from('socialbot_media_assets').select('*').eq('client_id', c.id).order('created_at', {ascending:false});
    const { data: rules } = await sb.from('socialbot_auto_reply_rules').select('*').eq('client_id', c.id);
    const { data: posts } = await sb.from('socialbot_posts').select('*').eq('client_id', c.id).order('created_at', {ascending:false}).limit(20);
    const { data: leads } = await sb.from('socialbot_leads').select('*').eq('client_id', c.id).order('created_at', { ascending:false });
    // Punto 8 (propuestas-30-07-2026.md): sugerencias de mensaje de
    // referido/reseña armadas solas cuando un lead pasa a 'convertido'.
    const { data: referrals } = await sb.from('socialbot_referral_suggestions').select('*').eq('client_id', c.id).order('created_at', { ascending:false });
    // Punto 9 (propuestas-30-07-2026.md): último caso de éxito generado
    // automáticamente cada mes (success_story_generator.py --all). Solo
    // se guarda la fila más reciente por cliente (unique en client_id).
    const { data: successStoryRows } = await sb.from('socialbot_success_stories').select('*').eq('client_id', c.id).maybeSingle();
    // Punto 12 (propuestas-30-07-2026.md): comentarios/DMs escalados por
    // sentimiento negativo (ya no se autoresponden, quedan acá esperando
    // que la agencia los atienda).
    const { data: flaggedComments } = await sb.from('socialbot_flagged_comments').select('*').eq('client_id', c.id).order('created_at', { ascending:false });
    // Punto 13 (propuestas-30-07-2026.md): cuántas respuestas con IA ya
    // se usaron hoy, para compararlas contra el límite diario del cliente
    // (socialbot_ai_settings.daily_ai_reply_limit) antes de que caiga solo
    // a la plantilla fija sin avisar a nadie.
    const todayIso = new Date().toISOString().slice(0, 10);
    const { data: aiUsageRow } = await sb.from('socialbot_ai_usage_log').select('call_count').eq('client_id', c.id).eq('usage_date', todayIso).maybeSingle();
    const { data: pendingPosts } = await sb.from('socialbot_posts').select('*').eq('client_id', c.id).eq('approval_status', 'pending').order('created_at', { ascending:false });
    const { data: planItems } = await sb.from('socialbot_content_plan_items').select('*').eq('client_id', c.id).in('status', ['proposed','approved']).order('target_date', { ascending:true });
    const { data: reviews } = await sb.from('socialbot_reviews').select('*').eq('client_id', c.id).order('review_created_at', { ascending:false }).limit(20);

    const ai = (aiRows && aiRows[0]) || {};
    const leadsNuevos = (leads||[]).filter(l => l.status === 'nuevo').length;
    const reviewsNuevas = (reviews||[]).filter(r => r.status === 'nueva').length;

    // Guardamos cliente + todas sus cuentas conectadas para poder abrir el
    // modal "Editar cliente" sin volver a pedirle nada a Supabase, y para
    // poder ubicar la cuenta correcta según la plataforma elegida (ver
    // openEditClientModal / onEditClientPlatformChange).
    clientsCache[c.id] = { client: c, accounts: accounts || [] };

    // Recién acá clientsCache ya tiene los límites de storage de ESTE
    // cliente (storage_limit_mb / storage_warn_mb), así que el badge y los
    // inputs de "Ajustar límites" usan el valor correcto y no el de
    // respaldo (ver getArchivosHostStorageLimits).
    updateArchivosHostStorageBadge();


    // Para los medios tipo 'carousel' no hay una unica url en el propio
    // media_asset; contamos cuantas imagenes tiene cada uno para mostrarlo
    // en el resumen (ver socialbot_carousel_items).
    const carouselMediaIds = (media||[]).filter(m => m.media_type === 'carousel').map(m => m.id);
    let carouselCounts = {};
    let carouselUrlsByAsset = {};
    if(carouselMediaIds.length){
      const { data: items } = await sb.from('socialbot_carousel_items').select('media_asset_id, url, position').in('media_asset_id', carouselMediaIds).order('position');
      (items||[]).forEach(it => {
        carouselCounts[it.media_asset_id] = (carouselCounts[it.media_asset_id]||0) + 1;
        (carouselUrlsByAsset[it.media_asset_id] = carouselUrlsByAsset[it.media_asset_id] || []).push(it.url);
      });
    }

    // ── Pestaña "Inicio": última publicación del cliente, estilo Instagram
    // (mismo criterio que el dashboard de cliente en index.html) — se arma
    // con los `posts` ya traídos arriba, sin pegarle de nuevo a Supabase.
    renderHomeView(c, posts || []);

    // ── Pestaña "Clientes": resumen + accesos + posts pendientes de aprobación ──
    const div = document.createElement('div');
    div.className = 'card client-card';
    div.dataset.clientId = c.id;
    div.innerHTML = `
      <div class="card-row">
        <div style="display:flex; align-items:center; gap:8px;">
          ${c.logo_url ? `<img src="${normalizeUrl(c.logo_url)}" alt="" style="width:28px; height:28px; object-fit:contain; border-radius:6px;" onerror="this.style.display='none';" />` : ''}
          <span class="client-name">${c.name}</span>
          <span class="pill ${c.active ? '' : 'off'}">${c.active ? 'activo' : 'pausado'}</span>
        </div>
        <div style="display:flex; flex-wrap:wrap; gap:8px;">
          <button class="secondary" onclick="toggleActive('${c.id}', ${c.active}, '${(c.name||'').replace(/'/g,"\\'")}')">${c.active ? 'Pausar' : 'Reactivar'}</button>
          <button class="secondary" title="Editar cliente" onclick="openEditClientModal('${c.id}')"><svg viewBox="0 0 24 24" style="width:14px; height:14px; vertical-align:-2px; margin-right:4px; fill:none; stroke:currentColor; stroke-width:1.8;"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>Editar</button>
          <button class="secondary" title="Guion para que el cliente hable a cámara" onclick="openCameraScriptModal('${c.id}', '${(c.name||'').replace(/'/g,"\\'")}')">🎬 Guion para cámara</button>
          <button class="reject" onclick="openDeleteClientModal('${c.id}', '${(c.name||'').replace(/'/g,"\\'")}')">Eliminar</button>
        </div>
      </div>
      <div class="meta-row">Link de venta: ${c.sales_link || '—'}</div>
      <div class="meta-row">Cuentas conectadas: ${(accounts||[]).map(a => `${a.platform} (${a.page_name||a.page_id})`).join(', ') || 'ninguna aún'}</div>
      <div class="meta-row">Acceso del cliente: ${c.client_email || 'sin asignar'} ${c.client_user_id ? '<span class="pill">ya entró</span>' : (c.client_email ? '<span class="pill off">pendiente</span>' : '')}</div>

      ${(pendingPosts||[]).length ? `
      <div style="margin-top:14px;">
        <div class="meta-row" style="margin-bottom:6px;">
          <strong>${pendingPosts.length} post(s) esperando aprobación</strong> — normalmente los aprueba el cliente desde su portal, pero también podés hacerlo vos acá (ej. si el cliente todavía no tiene acceso, o hay apuro).
        </div>
        <div class="btn-row" style="margin-bottom:10px;">
          <button onclick="approveAllPending('${c.id}')">Aprobar todos (${pendingPosts.length})</button>
          <button class="secondary" onclick="approveSelectedPending('${c.id}')">Aprobar selección</button>
        </div>
        <div data-client-pending="${c.id}">
          ${pendingPosts.map(p => `
            <div class="card pending" style="margin-top:8px;">
              <div class="card-row" style="margin-bottom:6px;">
                <label style="font-size:13px; color:var(--muted);">
                  <input aria-label="Seleccionar publicación" type="checkbox" class="pending-check" data-post-id="${p.id}" style="width:auto; vertical-align:middle;" />
                  Seleccionar este post
                </label>
              </div>
              <label class="sr-only" for="agency-caption-${p.id}">Texto del post</label>
              <textarea id="agency-caption-${p.id}" aria-label="Texto del post" rows="3">${(p.caption||'').replace(/</g,'&lt;')}</textarea>
              <div class="btn-row">
                <button class="secondary" onclick="saveCaptionAsAgency('${p.id}')">Guardar texto</button>
                <button onclick="reviewPostAsAgency('${p.id}', 'approved')">Aprobar</button>
                <button class="reject" onclick="reviewPostAsAgency('${p.id}', 'rejected')">Rechazar</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <form class="inline" onsubmit="saveClientPortalAccess(event, '${c.id}')" style="margin-top:8px; max-width:340px;">
        <label class="sr-only" for="clientEmail-${c.id}">Email del cliente para el portal</label>
        <input aria-label="Email del cliente para el portal" name="client_email" id="clientEmail-${c.id}" placeholder="Email del cliente (portal)" value="${c.client_email || ''}" />
        <label style="font-size:13px; color:var(--muted);">
          <input aria-label="Requiere aprobación antes de publicar" type="checkbox" name="require_approval" ${c.require_approval ? 'checked' : ''} style="width:auto; vertical-align:middle;" />
          El cliente debe aprobar cada post antes de publicarse
        </label>
        <button type="submit" class="secondary">Guardar acceso</button>
      </form>
    `;
    container.appendChild(div);

    // Punto 15 (propuestas-30-07-2026.md): mismo estilo visual que la
    // sugerencia de horarios (medallas + barra relativa de enganche),
    // pero para el ranking de tipo de gancho (pregunta/oferta/testimonio/
    // urgencia/dato curioso) en vez de dia+hora. Es puramente informativo,
    // sin boton de accion -- ya se usa solo dentro del prompt de la IA
    // (content_planner.py lo prioriza automaticamente), esto es la parte
    // visual que faltaba del dato que ya se calculaba.
    const hookTypeLabels = { pregunta:'❓ Pregunta', oferta:'🏷️ Oferta', testimonio:'💬 Testimonio', urgencia:'⏰ Urgencia', dato_curioso:'💡 Dato curioso', otro:'📄 Otro' };
    const hookRankingHtml = (hookTypeRanking && hookTypeRanking.length)
      ? (() => {
          const sorted = [...hookTypeRanking].sort((a, b) => Number(b.avg_score) - Number(a.avg_score));
          const maxScore = Math.max(...sorted.map(s => Number(s.avg_score) || 0), 0.0001);
          const medals = ['🥇', '🥈', '🥉'];
          const rows = sorted.map((s, idx) => {
            const scoreNum = Number(s.avg_score) || 0;
            const barPct = Math.max(4, Math.round((scoreNum / maxScore) * 100));
            const rankPrefix = idx < 3 ? `${medals[idx]} ` : '';
            return `
              <div style="padding:6px 0; ${idx > 0 ? 'border-top:1px solid var(--line);' : ''}">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                  <span style="font-size:13px;">${rankPrefix}${hookTypeLabels[s.hook_type] || s.hook_type}</span>
                  <span style="font-size:11px; color:var(--muted); white-space:nowrap;">enganche ${scoreNum.toFixed(1)} · ${s.sample_size} posts</span>
                </div>
                <div style="margin-top:4px; max-width:220px; height:5px; background:rgba(255,255,255,0.08); border-radius:3px; overflow:hidden;">
                  <div style="height:100%; width:${barPct}%; background:var(--gold);"></div>
                </div>
              </div>
            `;
          }).join('');
          return `
            <div style="border:1px solid var(--gold); border-radius:8px; padding:12px; margin-bottom:14px; background:rgba(201,162,68,0.06);">
              <div style="font-size:13px; color:var(--gold); margin-bottom:2px;">🎣 Banco de ganchos ganadores (últimos 30 días)</div>
              <div style="font-size:11px; color:var(--muted); margin-bottom:8px;">Tipo de gancho por enganche promedio — la IA ya prioriza el mejor al armar el plan semanal.</div>
              ${rows}
            </div>
          `;
        })()
      : '';

    // ── Pestaña "Plan" ────────────────────────────────────────────────
    const planItemsSectionHtml = (planItems||[]).length ? `
        <div class="meta-row" style="margin-bottom:8px;">
          POST DE PUBLICACION (texto que va debajo del video, junto con los hashtags), generado automáticamente todos los lunes con base en métricas de posts, leads recientes y lo ya publicado. Editá el texto si hace falta y aprobá/rechaza o edita cada uno — el que quede aprobado se publica solo el día sugerido, con este texto y ese Hashtag.
        </div>
        <div class="plan-view-toggle" data-plan-toggle="${c.id}">
          <button data-mode="list" class="${(planViewMode[c.id]||'list')==='list'?'active':''}" onclick="setPlanView('${c.id}','list')">📋 Lista</button>
          <button data-mode="calendar" class="${planViewMode[c.id]==='calendar'?'active':''}" onclick="setPlanView('${c.id}','calendar')">📅 Calendario</button>
        </div>
        <div id="planCalView-${c.id}" style="display:${planViewMode[c.id]==='calendar'?'block':'none'};">
          ${buildPlanCalendarHtml(planItems)}
        </div>
        <div id="planListView-${c.id}" style="display:${(planViewMode[c.id]||'list')==='list'?'block':'none'};">
        ${planItems.map(item => `
          <div class="card ${item.status === 'approved' ? '' : 'pending'}" style="margin-top:8px;">
            <div class="meta-row" style="margin-bottom:6px;">
              <strong>${new Date(item.target_date + 'T00:00:00').toLocaleDateString('es-AR', { weekday:'long', day:'numeric', month:'short' })}</strong>
              ${item.angle ? ` · <span class="pill">${item.angle}</span>` : ''}
              ${item.status === 'approved' ? ' · <span class="pill">aprobado, se publica solo</span>' : ''}
            </div>
            ${item.based_on ? `<div class="meta-row" style="font-style:italic; margin-bottom:8px;">${item.based_on}</div>` : ''}
            <label class="sr-only" for="plan-caption-${item.id}">Texto del post</label>
            <textarea id="plan-caption-${item.id}" aria-label="Texto del post" rows="4" ${item.status === 'approved' ? 'disabled' : ''}>${(item.caption||'').replace(/</g,'&lt;')}</textarea>
            <div style="font-size:12px; color:var(--muted); display:block; margin-top:8px;">Hashtags de este post (los propuso la IA — editalos, borralos, o agregá los tuyos antes de aprobar)</div>
            ${item.status === 'approved'
              ? `<div class="hashtag-row">${hashtagsToArray(item.hashtags).map(t => `<span class="hashtag-chip" style="padding:3px 12px;">${t}</span>`).join('') || '<span class="meta-row" style="margin-top:0;">sin hashtags</span>'}</div>`
              : hashtagEditorHtml(`plan-hashtags-${item.id}`, item.hashtags)}
            <div class="btn-row">
              ${item.status === 'approved' ? `
                <button class="secondary" onclick="reviewContentPlanItem('${item.id}', 'proposed')">Volver a editar</button>
                <button class="reject" onclick="reviewContentPlanItem('${item.id}', 'rejected')">Rechazar</button>
              ` : `
                <button class="secondary" onclick="saveContentPlanItem('${item.id}')">Guardar cambios</button>
                <button onclick="reviewContentPlanItem('${item.id}', 'approved')">Aprobar (se publica con este texto y estos hashtags)</button>
                <button class="reject" onclick="reviewContentPlanItem('${item.id}', 'rejected')">Rechazar</button>
              `}
            </div>
          </div>
        `).join('')}
        </div>
      ` : '';

    if((planItems||[]).length || hookRankingHtml){
      const planDiv = document.createElement('div');
      planDiv.className = 'card client-card';
      planDiv.dataset.clientId = c.id;
      planDiv.innerHTML = `
        <div class="section-client-heading">${c.name} · ${(planItems||[]).length} idea(s)</div>
        ${hookRankingHtml}
        ${planItemsSectionHtml}
      `;
      planContainer.appendChild(planDiv);
    }

    // ── Pestaña "Reseñas" ─────────────────────────────────────────────
    if((reviews||[]).length){
      const reviewsDiv = document.createElement('div');
      reviewsDiv.className = 'card client-card';
      reviewsDiv.dataset.clientId = c.id;
      reviewsDiv.innerHTML = `
        <div class="section-client-heading">${c.name} · ${reviews.length} total${reviewsNuevas ? `, ${reviewsNuevas} nueva(s)` : ''}</div>
        <div class="meta-row" style="margin-bottom:8px;">
          Se detectan solas cada pocas horas (scheduler/reviews_monitor.py). La respuesta sugerida la arma la IA — copiala y publicala vos desde Facebook/Google Business, revisando antes el tono.
        </div>
        ${reviews.map(r => {
          const isNeg = r.recommendation_type === 'negative' || (r.rating && r.rating <= 2);
          const isPos = r.recommendation_type === 'positive' || (r.rating && r.rating >= 4);
          const stars = r.rating ? '⭐'.repeat(Math.round(r.rating)) : (r.recommendation_type === 'positive' ? '👍 recomienda' : r.recommendation_type === 'negative' ? '👎 no recomienda' : '');
          return `
          <div class="review-card ${isNeg ? 'negative' : isPos ? 'positive' : ''}">
            <div class="meta-row" style="margin-top:0;">
              <strong>${r.platform === 'google' ? 'Google' : 'Facebook'}</strong> · ${stars} · ${r.author_name || 'anónimo'}
              ${r.status !== 'nueva' ? ` · <span class="pill">${r.status}</span>` : ''}
            </div>
            <div style="margin-top:4px;">${(r.review_text || '(sin texto)').replace(/</g,'&lt;')}</div>
            ${r.suggested_reply ? `<div class="review-suggested">💬 Sugerencia: ${r.suggested_reply.replace(/</g,'&lt;')}</div>` : ''}
            ${r.status === 'nueva' ? `
              <div class="btn-row">
                <button class="secondary" onclick="copyReviewReply('${r.id}')">Copiar respuesta sugerida</button>
                <button class="secondary" onclick="setReviewStatus('${r.id}', 'respondida')">Marcar como respondida</button>
                <button class="reject" onclick="setReviewStatus('${r.id}', 'ignorada')">Ignorar</button>
              </div>
            ` : ''}
          </div>`;
        }).join('')}
      `;
      reviewsContainer.appendChild(reviewsDiv);
    }

    // ── Pestaña "Config. IA" ──────────────────────────────────────────
    const iaDiv = document.createElement('div');
    iaDiv.className = 'card client-card';
    iaDiv.dataset.clientId = c.id;
    // Punto 13: barra de uso de IA de hoy vs el límite diario configurado
    // (default 30, mismo valor que usa meta-webhook si no hay nada cargado).
    const aiDailyLimit = ai.daily_ai_reply_limit || 30;
    const aiUsedToday = (aiUsageRow && aiUsageRow.call_count) || 0;
    const aiUsagePct = Math.min(100, Math.round((aiUsedToday / aiDailyLimit) * 100));
    const aiUsageColor = aiUsagePct >= 100 ? '#ef4444' : (aiUsagePct >= 80 ? 'var(--gold)' : '#22c55e');
    iaDiv.innerHTML = `
      <div class="section-client-heading">${c.name} · ${ai.provider || 'sin configurar'}</div>
      <div class="card" style="padding:10px 14px; margin-bottom:14px;">
        <div class="meta-row" style="margin-top:0; display:flex; justify-content:space-between;">
          <span>🤖 Respuestas con IA hoy</span>
          <strong>${aiUsedToday} / ${aiDailyLimit}${aiUsagePct >= 100 ? ' · límite alcanzado, cayendo a plantilla fija' : ''}</strong>
        </div>
        <div style="background:rgba(255,255,255,0.08); border-radius:999px; height:8px; margin-top:8px; overflow:hidden;">
          <div style="width:${aiUsagePct}%; height:100%; background:${aiUsageColor};"></div>
        </div>
      </div>
      <form class="inline" onsubmit="saveAi(event, '${c.id}')">
        <div class="grid2">
          <label class="sr-only" for="aiProvider-${c.id}">Proveedor de IA</label>
          <select aria-label="Proveedor de IA" name="provider" id="aiProvider-${c.id}">
            <option value="groq" ${ai.provider==='groq'?'selected':''}>IA (gratis)</option>
            <option value="openai" ${ai.provider==='openai'?'selected':''}>OpenAI</option>
            <option value="claude" ${ai.provider==='claude'?'selected':''}>Claude</option>
          </select>
          <label class="sr-only" for="aiTone-${c.id}">Tono de las respuestas</label>
          <input aria-label="Tono de las respuestas" name="tone" id="aiTone-${c.id}" placeholder="Tono (ej: cercano y profesional)" value="${ai.tone||''}" />
        </div>
        <div style="font-size:13px; color:var(--muted);">Idioma en el que la IA escribe los posts y contesta comentarios/DMs de este cliente</div>
        <label class="sr-only" for="aiReplyLanguage-${c.id}">Idioma de contenido</label>
        <select aria-label="Idioma de contenido" name="reply_language" id="aiReplyLanguage-${c.id}">
          <option value="pt-BR" ${(ai.reply_language||'pt-BR')==='pt-BR'?'selected':''}>Portugués (Brasil)</option>
          <option value="es" ${ai.reply_language==='es'?'selected':''}>Español</option>
          <option value="auto" ${ai.reply_language==='auto'?'selected':''}>Auto (detecta el idioma del mensaje, solo para respuestas)</option>
        </select>
        <div style="font-size:13px; color:var(--muted);">Límite de respuestas con IA por día — al llegar acá, el bot sigue respondiendo pero con una plantilla fija en vez de generar con IA</div>
        <label class="sr-only" for="aiDailyLimit-${c.id}">Límite diario de respuestas con IA</label>
        <input aria-label="Límite diario de respuestas con IA" name="daily_ai_reply_limit" id="aiDailyLimit-${c.id}" type="number" min="1" placeholder="30" value="${ai.daily_ai_reply_limit || ''}" />
        <div style="font-size:13px; color:var(--muted);">Modelo para el plan semanal de contenido (Fase 6) — independiente del de arriba, para no compartir cuota gratuita con las respuestas automáticas</div>
        <label class="sr-only" for="aiContentPlanProvider-${c.id}">Proveedor de IA para el plan de contenido</label>
        <select aria-label="Proveedor de IA para el plan de contenido" name="content_plan_provider" id="aiContentPlanProvider-${c.id}">
          <option value="groq" ${ai.content_plan_provider==='groq'?'selected':''}>IA (gratis)</option>
          <option value="openai" ${ai.content_plan_provider==='openai'?'selected':''}>OpenAI</option>
          <option value="claude" ${ai.content_plan_provider==='claude'?'selected':''}>Claude</option>
        </select>
        <label class="sr-only" for="aiTopics-${c.id}">Temas o palabras clave del negocio</label>
        <textarea aria-label="Temas o palabras clave del negocio" name="topics" id="aiTopics-${c.id}" placeholder="Temas/keywords del negocio">${ai.topics||''}</textarea>
        <div style="font-size:13px; color:var(--muted);">Hashtags de marca (fijos) — la IA los usa como base en cada idea del plan semanal, sumando 2-4 propios del tema del día. Si el cliente cargó sus propios hashtags desde su portal, los de él tienen prioridad sobre estos.</div>
        ${hashtagEditorHtml(`hashtags-${c.id}`, ai.default_hashtags)}
        <div style="font-size:13px; color:var(--muted);">Base de conocimiento (servicios, precios reales, FAQ, políticas — la IA la usa como fuente de verdad, no inventa datos)</div>
        <label class="sr-only" for="aiKnowledgeBase-${c.id}">Base de conocimiento</label>
        <textarea aria-label="Base de conocimiento" name="knowledge_base" id="aiKnowledgeBase-${c.id}" rows="6" placeholder="Ej: Ofrecemos gestión de redes desde $200/mes. Horario de atención: L-V 9-18hs. No hacemos devoluciones después de 7 días. Envíos a todo el país...">${ai.knowledge_base||''}</textarea>
        <label class="sr-only" for="aiSystemPrompt-${c.id}">Instrucciones para la IA</label>
        <textarea aria-label="Instrucciones para la IA" name="system_prompt" id="aiSystemPrompt-${c.id}" placeholder="Instrucciones para la IA">${ai.system_prompt||''}</textarea>
        <button type="submit">Guardar configuración</button>
      </form>
    `;
    iaContainer.appendChild(iaDiv);

    // ── Pestaña "Horarios" ────────────────────────────────────────────
    const horariosDiv = document.createElement('div');
    horariosDiv.className = 'card client-card';
    horariosDiv.dataset.clientId = c.id;
    const sortedSlots = [...(slots||[])].sort((a, b) => {
      const da = a.day_of_week ?? 0; // "Todos los días" primero
      const db = b.day_of_week ?? 0;
      if(da !== db) return da - db;
      if(a.hour !== b.hour) return a.hour - b.hour;
      return a.minute - b.minute;
    });
    // Propuesta 5 (propuestas-30-07-2026.md): sugerencia de horario segun
    // engagement real, calculada por content_planner.py y guardada en
    // socialbot_suggested_schedule. Solo informativo -- no cambia los
    // horarios activos hasta que la agencia toque "Usar este horario".
    //
    // AJUSTE 30/07/2026: la lista completa (sin distinguir top de resto,
    // y mostrando solo "X posts") generaba confusion -- se veia como una
    // lista sin orden claro, porque el ranking real es por ENGANCHE
    // PROMEDIO (likes+comments*2+shares*3), no por cantidad de posts, y
    // ese numero no se mostraba en ningun lado. Ahora se resaltan las 3
    // mejores con medalla + barra relativa de enganche, y el resto queda
    // colapsado atras de un "ver mas".
    const suggestedHtml = (suggestedSchedule && suggestedSchedule.length)
      ? (() => {
          const sorted = [...suggestedSchedule].sort((a, b) => Number(b.avg_score) - Number(a.avg_score));
          const maxScore = Math.max(...sorted.map(s => Number(s.avg_score) || 0), 0.0001);
          const medals = ['🥇', '🥈', '🥉'];
          const renderRow = (s, idx) => {
            const scoreNum = Number(s.avg_score) || 0;
            const barPct = Math.max(4, Math.round((scoreNum / maxScore) * 100));
            const rankPrefix = idx < 3 ? `${medals[idx]} ` : '';
            return `
              <div style="padding:6px 0; ${idx > 0 ? 'border-top:1px solid var(--line);' : ''}">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
                  <span style="font-size:13px;">${rankPrefix}${_WEEKDAY_NAMES_ES_JS[s.day_of_week]} alrededor de las ${s.hour}hs</span>
                  <button type="button" class="secondary" style="padding:4px 10px; font-size:12px; flex-shrink:0;" onclick="useSuggestedSlot('${c.id}', ${s.hour}, ${s.day_of_week})">Usar este horario</button>
                </div>
                <div style="display:flex; align-items:center; gap:8px; margin-top:4px;">
                  <div style="flex:1; max-width:160px; height:5px; background:rgba(255,255,255,0.08); border-radius:3px; overflow:hidden;">
                    <div style="height:100%; width:${barPct}%; background:var(--gold);"></div>
                  </div>
                  <span style="font-size:11px; color:var(--muted); white-space:nowrap;">enganche ${scoreNum.toFixed(1)} · ${s.sample_size} posts</span>
                </div>
              </div>
            `;
          };
          const top3 = sorted.slice(0, 3);
          const rest = sorted.slice(3);
          return `
            <div style="border:1px solid var(--gold); border-radius:8px; padding:12px; margin-bottom:14px; background:rgba(201,162,68,0.06);">
              <div style="font-size:13px; color:var(--gold); margin-bottom:2px;">📊 Horario sugerido según enganche real (últimos 30 días)</div>
              <div style="font-size:11px; color:var(--muted); margin-bottom:8px;">Ordenado por enganche promedio (likes/comentarios/compartidos) — no por cantidad de posts.</div>
              ${top3.map(renderRow).join('')}
              ${rest.length ? `
                <details style="margin-top:6px;">
                  <summary style="cursor:pointer; font-size:12px; color:var(--muted);">Ver ${rest.length} opción${rest.length > 1 ? 'es' : ''} más</summary>
                  <div style="margin-top:4px;">${rest.map((s, i) => renderRow(s, i + 3)).join('')}</div>
                </details>
              ` : ''}
            </div>
          `;
        })()
      : '';
    horariosDiv.innerHTML = `
      <div class="section-client-heading">${c.name} · ${sortedSlots.length}</div>
      ${suggestedHtml}
      <form class="inline" onsubmit="saveAllSlots(event, '${c.id}')">
        ${sortedSlots.map(s => `
          <div class="slot-card" data-slot-id="${s.id}" style="border-top:1px solid var(--line); padding-top:10px; margin-top:10px;">
            <div class="grid2">
              <label class="sr-only" for="slotHour-${s.id}">Hora</label>
              <input data-field="hour" id="slotHour-${s.id}" name="slotHour-${s.id}" type="number" min="0" max="23" value="${s.hour}" placeholder="Hora (0-23)" aria-label="Hora" required />
              <label class="sr-only" for="slotMinute-${s.id}">Minuto</label>
              <input data-field="minute" id="slotMinute-${s.id}" name="slotMinute-${s.id}" type="number" min="0" max="59" value="${s.minute}" placeholder="Minuto" aria-label="Minuto" />
            </div>
            <label class="sr-only" for="slotDow-${s.id}">Día de la semana</label>
            <select data-field="day_of_week" id="slotDow-${s.id}" name="slotDow-${s.id}" aria-label="Día de la semana">
              <option value="" ${!s.day_of_week ? 'selected' : ''}>Todos los días</option>
              <option value="1" ${s.day_of_week===1?'selected':''}>Lunes</option>
              <option value="2" ${s.day_of_week===2?'selected':''}>Martes</option>
              <option value="3" ${s.day_of_week===3?'selected':''}>Miércoles</option>
              <option value="4" ${s.day_of_week===4?'selected':''}>Jueves</option>
              <option value="5" ${s.day_of_week===5?'selected':''}>Viernes</option>
              <option value="6" ${s.day_of_week===6?'selected':''}>Sábado</option>
              <option value="7" ${s.day_of_week===7?'selected':''}>Domingo</option>
            </select>
            <label class="meta-row" style="margin-top:0;"><input data-field="active" id="slotActive-${s.id}" name="slotActive-${s.id}" type="checkbox" ${s.active ? 'checked' : ''} style="width:auto; vertical-align:middle;" /> Activo</label>
            <button type="button" class="secondary" title="Eliminar horario" aria-label="Eliminar horario" onclick="deleteSlot('${s.id}', '${c.id}')" style="display:inline-flex; align-items:center; justify-content:center; width:36px; height:36px; padding:0;">
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                <path d="M10 11v6"></path>
                <path d="M14 11v6"></path>
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path>
              </svg>
            </button>
          </div>
        `).join('') || '<div>sin horarios</div>'}
        ${sortedSlots.length ? '<button type="submit" style="margin-top:14px;">Guardar cambios</button>' : ''}
      </form>
      <form class="inline" onsubmit="addSlot(event, '${c.id}')" style="border-top:1px solid var(--line); padding-top:10px; margin-top:10px;">
        <div class="grid2">
          <label class="sr-only" for="newSlotHour-${c.id}">Hora</label>
          <input aria-label="Hora" name="hour" id="newSlotHour-${c.id}" type="number" min="0" max="23" placeholder="Hora (0-23)" required />
          <label class="sr-only" for="newSlotMinute-${c.id}">Minuto</label>
          <input aria-label="Minuto" name="minute" id="newSlotMinute-${c.id}" type="number" min="0" max="59" placeholder="Minuto" value="0" />
        </div>
        <label class="sr-only" for="newSlotDow-${c.id}">Día de la semana</label>
        <select aria-label="Día de la semana" name="day_of_week" id="newSlotDow-${c.id}">
          <option value="">Todos los días</option>
          <option value="1">Lunes</option>
          <option value="2">Martes</option>
          <option value="3">Miércoles</option>
          <option value="4">Jueves</option>
          <option value="5">Viernes</option>
          <option value="6">Sábado</option>
          <option value="7">Domingo</option>
        </select>
        <button type="submit">Agregar horario</button>
      </form>
    `;
    horariosContainer.appendChild(horariosDiv);

    // ── Pestaña "Medios" ──────────────────────────────────────────────
    // Orden real de publicación: pick_media() en post_scheduler.py primero
    // busca si hay algun medio con manual_order asignado (el numero que vos
    // cargues acá) y usa ESE, ordenado 1,2,3... Si no hay ninguno con
    // manual_order, cae a la rotacion automatica de siempre (menor
    // times_used primero, desempate por mas antiguo). Reproducimos la MISMA
    // regla acá para mostrar la fila real, no una inventada. Al publicarse
    // con éxito, el manual_order de ese medio se limpia solo y vuelve a la
    // rotación automática.
    const mediaQueueOrder = [...(media||[])].sort((a, b) => {
      const aManual = a.manual_order != null;
      const bManual = b.manual_order != null;
      if (aManual && bManual) return a.manual_order - b.manual_order;
      if (aManual !== bManual) return aManual ? -1 : 1;
      if (a.times_used !== b.times_used) return a.times_used - b.times_used;
      return new Date(a.created_at) - new Date(b.created_at);
    });
    const mediaQueueRank = new Map(mediaQueueOrder.map((m, idx) => [m.id, idx + 1]));

    const mediosDiv = document.createElement('div');
    mediosDiv.className = 'card client-card';
    mediosDiv.dataset.clientId = c.id;
    mediosDiv.innerHTML = `
      <div class="section-client-heading">${c.name} · ${(media||[]).length}</div>
      ${mediaQueueOrder.length ? `<div class="meta-row" style="margin-bottom:6px;">Orden real de rotación. Dejá "Orden manual" vacío para que se rija por el automático (<code>times_used</code>); ponele un número (1, 2, 3...) para forzar que salga en ese lugar de la fila — se consume solo y vuelve a automático apenas se publica.</div>` : ''}
      ${mediaQueueOrder.map(m => `
        <form class="inline" onsubmit="updateMedia(event, '${m.id}', '${c.id}', '${m.media_type}')" style="border-top:1px solid var(--line); padding-top:10px; margin-top:10px;">
          <div class="meta-row">
            <span class="pill" style="background:var(--accent-soft); color:var(--gold); font-weight:700; margin-right:6px;">${mediaQueueRank.get(m.id) === 1 ? '▶ Próxima a publicar' : `${mediaQueueRank.get(m.id)}º en la fila`}</span>
            ${m.media_type}${m.media_type==='carousel' ? ` (${carouselCounts[m.id]||0} imágenes)` : ''} · usado ${m.times_used}x${m.manual_order != null ? ` · orden manual: ${m.manual_order}` : ''}
          </div>
          <label class="sr-only" for="mediaManualOrder-${m.id}">Orden manual</label>
          <input aria-label="Orden manual" name="manual_order" id="mediaManualOrder-${m.id}" type="number" min="1" step="1" value="${m.manual_order != null ? m.manual_order : ''}" placeholder="Orden manual (opcional, ej: 1). Vacío = automático" />
          ${m.media_type === 'carousel' ? `
          <label class="sr-only" for="mediaCarouselUrls-${m.id}">URLs de imágenes del carrusel</label>
          <textarea aria-label="URLs de imágenes del carrusel" name="carousel_urls" id="mediaCarouselUrls-${m.id}" placeholder="Una URL de imagen por línea (entre 2 y 10)">${(carouselUrlsByAsset[m.id]||[]).join('\n')}</textarea>
          ` : `
          <label class="sr-only" for="mediaUrl-${m.id}">URL pública del video o imagen</label>
          <input aria-label="URL pública del video o imagen" name="url" id="mediaUrl-${m.id}" value="${(m.url||'').replace(/"/g,'&quot;')}" placeholder="URL pública del video/imagen (https://...)" />
          <label class="sr-only" for="mediaFbPhotoUrl-${m.id}">URL de foto para Facebook</label>
          <input aria-label="URL de foto para Facebook" name="fb_photo_url" id="mediaFbPhotoUrl-${m.id}" value="${(m.fb_photo_url||'').replace(/"/g,'&quot;')}" placeholder="URL de foto para Facebook (opcional, solo si es video)" />
          `}
          <label class="sr-only" for="mediaCaptionOverride-${m.id}">Caption fijo</label>
          <textarea aria-label="Caption fijo" name="caption_override" id="mediaCaptionOverride-${m.id}" placeholder="Caption fijo (opcional). Si lo dejás vacío, el bot genera uno con IA cada vez.">${m.caption_override||''}</textarea>
          <label class="sr-only" for="mediaHashtagsOverride-${m.id}">Hashtags fijos para este medio</label>
          <input aria-label="Hashtags fijos para este medio" name="hashtags_override" id="mediaHashtagsOverride-${m.id}" value="${(m.hashtags_override||'').replace(/"/g,'&quot;')}" placeholder="Hashtags fijos para este medio (opcional, ej: #promo #oferta)" />
          <div class="btn-row">
            <button type="submit" class="secondary">Guardar cambios</button>
            <button type="button" onclick="publishMediaNow('${m.id}', '${c.id}', '${(c.name||'').replace(/'/g,"\\'")}')">Publicar ahora</button>
            <button type="button" class="reject" onclick="deleteMedia('${m.id}', '${c.id}')">Eliminar</button>
          </div>
        </form>
      `).join('') || '<div class="meta-row">sin medios cargados</div>'}
      <form class="inline" onsubmit="addMedia(event, '${c.id}')" style="border-top:1px solid var(--line); padding-top:10px; margin-top:10px;">
        <div class="meta-row" style="font-weight:600;">Agregar medio nuevo</div>
        <label class="sr-only" for="newMediaTypeSelect">Tipo de medio</label>
        <select aria-label="Tipo de medio" name="media_type" id="newMediaTypeSelect" onchange="toggleMediaTypeFields(this)">
          <option value="video">Video / Reel</option>
          <option value="image">Imagen</option>
          <option value="carousel">Carrusel (varias imágenes)</option>
        </select>
        <label class="sr-only" for="newMediaUrlInput">URL pública del video o imagen</label>
        <input aria-label="URL pública del video o imagen" name="url" id="newMediaUrlInput" placeholder="URL pública del video/imagen (https://...)" />
        <label class="sr-only" for="newMediaCarouselUrls-${c.id}">URLs del carrusel</label>
        <textarea aria-label="URLs del carrusel" name="carousel_urls" id="newMediaCarouselUrls-${c.id}" placeholder="Solo para carrusel: una URL de imagen por línea (entre 2 y 10)" style="display:none;"></textarea>
        <label class="sr-only" for="newMediaFbPhotoUrl-${c.id}">URL de foto para Facebook</label>
        <input aria-label="URL de foto para Facebook" name="fb_photo_url" id="newMediaFbPhotoUrl-${c.id}" placeholder="URL de foto para Facebook (opcional, solo si el medio de arriba es un video). Si la cargás, en Facebook se publica esta foto en vez del video." />
        <label class="sr-only" for="newMediaCaptionOverride-${c.id}">Caption fijo</label>
        <textarea aria-label="Caption fijo" name="caption_override" id="newMediaCaptionOverride-${c.id}" placeholder="Caption fijo (opcional). Si lo dejás vacío, el bot genera uno con IA cada vez."></textarea>
        <label class="sr-only" for="newMediaHashtagsOverride-${c.id}">Hashtags fijos para este medio</label>
        <input aria-label="Hashtags fijos para este medio" name="hashtags_override" id="newMediaHashtagsOverride-${c.id}" placeholder="Hashtags fijos para este medio (opcional, ej: #promo #oferta). Se agregan al final del caption fijo de arriba." />
        <div class="meta-row" style="margin-top:0;">Si el cliente cargó su propio texto/hashtags fijos desde su portal, los del cliente tienen prioridad sobre estos.</div>
        <button type="submit">Agregar medio</button>
      </form>
    `;
    mediosContainer.appendChild(mediosDiv);

    // ── Pestaña "Auto-respuesta" ──────────────────────────────────────
    const autorespDiv = document.createElement('div');
    autorespDiv.className = 'card client-card';
    autorespDiv.dataset.clientId = c.id;
    autorespDiv.innerHTML = `
      <div class="section-client-heading">${c.name} · ${(rules||[]).length}</div>
      ${(rules||[]).map(r => `
        <form class="inline" onsubmit="updateRule(event, '${r.id}', '${c.id}')" style="border-top:1px solid var(--line); padding-top:10px; margin-top:10px;">
          <div class="grid2">
            <label class="sr-only" for="ruleKeyword-${r.id}">Palabra clave</label>
            <input aria-label="Palabra clave" name="keyword" id="ruleKeyword-${r.id}" value="${(r.keyword||'').replace(/"/g,'&quot;')}" placeholder="Palabra clave" required />
            <label class="sr-only" for="ruleMatchType-${r.id}">Tipo de coincidencia</label>
            <select aria-label="Tipo de coincidencia" name="match_type" id="ruleMatchType-${r.id}">
              <option value="both" ${r.match_type==='both'?'selected':''}>Comentarios + DMs</option>
              <option value="comment" ${r.match_type==='comment'?'selected':''}>Solo comentarios</option>
              <option value="dm" ${r.match_type==='dm'?'selected':''}>Solo DMs</option>
            </select>
          </div>
          <label class="sr-only" for="ruleReplyTemplate-${r.id}">Plantilla de respuesta</label>
          <textarea aria-label="Plantilla de respuesta" name="reply_template" id="ruleReplyTemplate-${r.id}" placeholder="Respuesta. Usá {{sales_link}} para el link" required>${r.reply_template||''}</textarea>
          <div class="grid2">
            <button type="submit">Guardar cambios</button>
            <button type="button" class="secondary" onclick="deleteRule('${r.id}', '${c.id}')">Eliminar</button>
          </div>
        </form>
      `).join('') || '<div>sin reglas</div>'}
      <form class="inline" onsubmit="addRule(event, '${c.id}')" style="border-top:1px solid var(--line); padding-top:10px; margin-top:10px;">
        <label class="sr-only" for="newRuleKeyword-${c.id}">Palabra clave</label>
        <input aria-label="Palabra clave" name="keyword" id="newRuleKeyword-${c.id}" placeholder="Palabra clave (ej: precio, quiero, info)" required />
        <label class="sr-only" for="newRuleMatchType-${c.id}">Tipo de coincidencia</label>
        <select aria-label="Tipo de coincidencia" name="match_type" id="newRuleMatchType-${c.id}">
          <option value="both">Comentarios + DMs</option>
          <option value="comment">Solo comentarios</option>
          <option value="dm">Solo DMs</option>
        </select>
        <label class="sr-only" for="newRuleReplyTemplate-${c.id}">Plantilla de respuesta</label>
        <textarea aria-label="Plantilla de respuesta" name="reply_template" id="newRuleReplyTemplate-${c.id}" placeholder="Respuesta. Usá {{sales_link}} para el link" required></textarea>
        <button type="submit">Agregar regla</button>
      </form>
    `;
    autorespContainer.appendChild(autorespDiv);

    // ── Pestaña "Posts" ───────────────────────────────────────────────
    const postsDiv = document.createElement('div');
    postsDiv.className = 'card client-card';
    postsDiv.dataset.clientId = c.id;
    postsDiv.innerHTML = `
      <div class="section-client-heading">${c.name}</div>
      <div class="posts-filter-row" style="margin-bottom:10px;">
        <label class="sr-only" for="postsFilterStatus-${c.id}">Filtrar por estado</label>
        <select aria-label="Filtrar por estado" id="postsFilterStatus-${c.id}" onchange="renderPostsList('${c.id}')">
          <option value="all">Todos los estados</option>
          <option value="published">Publicados</option>
          <option value="failed">Fallidos</option>
          <option value="pending">Pendientes</option>
          <option value="publishing">Publicando</option>
        </select>
        <label class="sr-only" for="postsFilterPlatform-${c.id}">Filtrar por plataforma</label>
        <select aria-label="Filtrar por plataforma" id="postsFilterPlatform-${c.id}" onchange="renderPostsList('${c.id}')">
          <option value="all">Todas las plataformas</option>
          <option value="facebook">Facebook</option>
          <option value="instagram">Instagram</option>
        </select>
        <label class="sr-only" for="postsFilterDate-${c.id}">Filtrar por fecha</label>
        <select aria-label="Filtrar por fecha" id="postsFilterDate-${c.id}" onchange="renderPostsList('${c.id}')">
          <option value="all">Todas las fechas</option>
        </select>
      </div>
      <div id="posts-list-${c.id}"></div>
    `;
    postsContainer.appendChild(postsDiv);

    // ── Pestaña "Métricas" (incluye el envío de resumen, que antes vivía
    // suelto arriba de todo en la tarjeta de cliente) ───────────────────
    const metricasDiv = document.createElement('div');
    metricasDiv.className = 'card client-card';
    metricasDiv.dataset.clientId = c.id;
    metricasDiv.innerHTML = `
      <div class="section-client-heading">${c.name}</div>
      <div class="meta-row" style="margin-top:0;">
        <div style="font-size:12px; color:var(--muted); display:block; margin-bottom:4px;">
          Enviar resumen de métricas ahora ${c.client_email ? '' : '(cargá un email de portal en la pestaña Clientes primero)'}
        </div>
        <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
          <label class="sr-only" for="reportPeriod-${c.id}">Período del reporte</label>
          <select aria-label="Período del reporte" id="reportPeriod-${c.id}" onchange="onReportPeriodChange('${c.id}')" style="width:auto;">
            <option value="this_month">Este mes</option>
            <option value="last_month">Mes pasado</option>
            <option value="last_30_days">Últimos 30 días</option>
            <option value="custom">Personalizado…</option>
          </select>
          <label class="sr-only" for="reportStart-${c.id}">Fecha de inicio</label>
          <input aria-label="Fecha de inicio" type="date" id="reportStart-${c.id}" style="display:none; width:auto;" />
          <label class="sr-only" for="reportEnd-${c.id}">Fecha de fin</label>
          <input aria-label="Fecha de fin" type="date" id="reportEnd-${c.id}" style="display:none; width:auto;" />
          <button type="button" class="secondary" ${c.client_email ? '' : 'disabled'} onclick="sendReportNow('${c.id}')">Enviar resumen</button>
        </div>
      </div>
      <div id="metrics-${c.id}"></div>
    `;
    metricasContainer.appendChild(metricasDiv);

    // ── Pestaña "Leads" ───────────────────────────────────────────────
    const leadsDiv = document.createElement('div');
    leadsDiv.className = 'card client-card';
    leadsDiv.dataset.clientId = c.id;
    leadsDiv.innerHTML = `
      <div class="section-client-heading">${c.name} · ${(leads||[]).length}${leadsNuevos ? ` · ${leadsNuevos} sin contactar` : ''}</div>
      ${(leads||[])
        .slice()
        .sort((a, b) => {
          const oa = parseLeadStage(a.interest).stageMeta?.order ?? 99;
          const ob = parseLeadStage(b.interest).stageMeta?.order ?? 99;
          return oa - ob;
        })
        .map(l => {
          const { stageMeta, text } = parseLeadStage(l.interest);
          const badge = stageMeta
            ? `<span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; color:#fff; background:${stageMeta.color}; margin-bottom:4px;">${stageMeta.label}</span>`
            : '';
          // El permalink puede venir directo en el lead (l.post_permalink) o,
          // si no está, lo buscamos en los posts ya traídos para este cliente
          // (mismo post_id) — así el link funciona aunque el webhook no haya
          // guardado el permalink en el lead en su momento.
          const originPost = l.post_id ? (posts||[]).find(p => p.id === l.post_id) : null;
          const permalink = l.post_permalink || (originPost && originPost.permalink_url) || null;
          return `
        <div class="card" style="margin-top:8px; padding:12px 14px;">
          <div class="card-row">
            <div>
              <strong>${l.name || 'Sin nombre'}</strong>
              <div class="meta-row" style="margin-top:2px;">${l.platform} · ${l.contact || 'sin contacto'}</div>
            </div>
            <label class="sr-only" for="leadStatus-${l.id}">Estado del lead</label>
            <select id="leadStatus-${l.id}" name="leadStatus-${l.id}" aria-label="Estado del lead" onchange="updateLeadStatus('${l.id}', this.value)">
              <option value="nuevo" ${l.status==='nuevo'?'selected':''}>Nuevo</option>
              <option value="contactado" ${l.status==='contactado'?'selected':''}>Contactado</option>
              <option value="convertido" ${l.status==='convertido'?'selected':''}>Convertido</option>
              <option value="descartado" ${l.status==='descartado'?'selected':''}>Descartado</option>
            </select>
          </div>
          <div>${badge}</div>
          <div class="meta-row">Interés: ${text}</div>
          <div class="meta-row" style="font-style:italic;">"${(l.source_text||'').replace(/"/g,'&quot;').slice(0,140)}"</div>
          <div class="meta-row" style="opacity:0.7; font-size:12px; margin-top:2px;">${l.created_at ? new Date(l.created_at).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : ''}</div>
          ${l.post_id ? `<div class="meta-row" style="font-size:12px;">${permalink ? `<a href="${permalink}" target="_blank" rel="noopener" style="color:var(--white); text-decoration:underline; display:inline-flex; align-items:center; gap:4px;">Ver publicación de origen (${l.platform === 'facebook' ? 'Facebook' : 'Instagram'})<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a>` : `Post: ${l.post_id}`}</div>` : ''}
        </div>
      `;}).join('') || '<div class="meta-row">sin leads todavía</div>'}
    `;
    leadsContainer.appendChild(leadsDiv);

    // ── Pestaña "Referidos" ───────────────────────────────────────────
    // Punto 8 de propuestas-30-07-2026.md: cuando un lead pasa a
    // 'convertido', el trigger trg_create_referral_suggestion arma un
    // mensaje sugerido acá (status='proposed') y avisa por mail. La
    // agencia (o el cliente, desde su propio panel) lo revisa, lo puede
    // editar, y recién al aprobar (status pasa a 'approved') el trigger
    // trg_send_referral_suggestion dispara send-referral-prompt, que lo
    // publica como respuesta pública debajo del comentario original del
    // lead (ver referencia-mensajeria-referidos.txt, 02/08/2026 -- ya no
    // se manda como mensaje privado/DM). Nunca se manda solo.
    const referidosDiv = document.createElement('div');
    referidosDiv.className = 'card client-card';
    referidosDiv.dataset.clientId = c.id;
    const REFERRAL_STATUS_META = {
      proposed: { label: 'Pendiente de revisión', color: 'var(--gold)' },
      approved: { label: 'Aprobado, enviando…', color: '#3b82f6' },
      sent:     { label: 'Enviado', color: '#22c55e' },
      rejected: { label: 'Descartado', color: 'var(--muted)' },
      failed:   { label: 'Error al enviar', color: '#ef4444' },
    };
    referidosDiv.innerHTML = `
      <div class="section-client-heading">${c.name} · ${(referrals||[]).length}</div>
      ${(referrals||[])
        .map(r => {
          const meta = REFERRAL_STATUS_META[r.status] || { label: r.status, color: 'var(--muted)' };
          const editable = r.status === 'proposed';
          const relatedLead = (leads||[]).find(l => l.id === r.lead_id);
          return `
        <div class="card" style="margin-top:8px; padding:12px 14px;">
          <div class="card-row">
            <div>
              <strong>${relatedLead?.name || 'Lead sin nombre'}</strong>
              <div class="meta-row" style="margin-top:2px;">${r.platform === 'facebook' ? 'Facebook' : 'Instagram'} · ${relatedLead?.contact || 'sin contacto'}</div>
            </div>
            <span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; color:#fff; background:${meta.color};">${meta.label}</span>
          </div>
          <label class="sr-only" for="referral-msg-${r.id}">Mensaje sugerido para el referido</label>
          <textarea aria-label="Mensaje sugerido para el referido" id="referral-msg-${r.id}" ${editable ? '' : 'disabled'} style="width:100%; min-height:70px; margin-top:8px; ${editable ? '' : 'opacity:0.7;'}">${(r.message||'').replace(/</g,'&lt;')}</textarea>
          ${r.answered_by ? `<div class="meta-row" style="font-size:12px;">Respondido por: ${r.answered_by === 'cliente' ? 'el cliente' : 'la agencia'}</div>` : ''}
          ${r.status === 'failed' && r.send_error ? `<div class="meta-row" style="color:#ef4444; font-size:12px;">Motivo: ${r.send_error}</div>` : ''}
          <div class="meta-row" style="opacity:0.7; font-size:12px; margin-top:2px;">${r.created_at ? new Date(r.created_at).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : ''}</div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            ${r.status === 'proposed' ? `
              <button type="button" onclick="approveReferralSuggestion('${r.id}')">Aprobar y enviar</button>
              <button type="button" class="secondary" onclick="rejectReferralSuggestion('${r.id}')">Descartar</button>
            ` : ''}
            ${r.status === 'failed' ? `<button type="button" onclick="approveReferralSuggestion('${r.id}')">Reintentar envío</button>` : ''}
          </div>
        </div>
      `;}).join('') || '<div class="meta-row">sin sugerencias de referido todavía</div>'}
    `;
    referidosContainer.appendChild(referidosDiv);

    // ── Tarjeta "Caso de éxito" (punto 9) ───────────────────────────────
    // Solo mostramos un botón que pide un signed URL fresco al tocarlo --
    // no guardamos ningún link ya armado en el HTML (el bucket es privado,
    // RLS igual que el resto de las tablas socialbot_*, ver
    // 0031_success_stories.sql).
    const successStoryCard = document.getElementById('successStoryCard');
    if(successStoryRows){
      const generatedLabel = successStoryRows.generated_at
        ? new Date(successStoryRows.generated_at).toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' })
        : '';
      successStoryCard.innerHTML = `
        <div class="card" style="padding:12px 14px; display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;">
          <div>
            <strong>📊 Caso de éxito de ${c.name}</strong>
            <div class="meta-row" style="margin-top:2px;">Última versión generada el ${generatedLabel} · últimos ${successStoryRows.days} días</div>
          </div>
          <button type="button" onclick="openSuccessStory('${successStoryRows.storage_path}')">Ver / descargar</button>
        </div>`;
    } else {
      successStoryCard.innerHTML = `
        <div class="card" style="padding:12px 14px;">
          <div class="meta-row">Todavía no se generó ningún caso de éxito automático para ${c.name} (corre el día 1 de cada mes para clientes activos con algo de actividad).</div>
        </div>`;
    }

    // ── Pestaña "Quejas" (punto 12) ─────────────────────────────────────
    const quejasContainer = document.getElementById('quejasList');
    const QUEJA_STATUS_META = {
      pendiente: { label: 'Pendiente', color: 'var(--warn, #ef4444)' },
      resuelto:  { label: 'Resuelto', color: '#22c55e' },
    };
    quejasContainer.innerHTML = `
      <div class="section-client-heading">${c.name} · ${(flaggedComments||[]).filter(f => f.status==='pendiente').length} pendiente(s)</div>
      ${(flaggedComments||[])
        .map(f => {
          const meta = QUEJA_STATUS_META[f.status] || { label: f.status, color: 'var(--muted)' };
          const dateLabel = f.created_at ? new Date(f.created_at).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
          return `
        <div class="card" style="margin-top:8px; padding:12px 14px;">
          <div class="card-row">
            <div class="meta-row" style="margin-top:0;">${f.platform === 'facebook' ? 'Facebook' : 'Instagram'} · ${dateLabel}${f.reason ? ' · ' + f.reason : ''}</div>
            <span style="display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; color:#fff; background:${meta.color};">${meta.label}</span>
          </div>
          <div style="margin-top:6px;">${(f.text||'').replace(/</g,'&lt;')}</div>
          ${f.status === 'pendiente' ? `<div style="margin-top:8px;"><button type="button" onclick="resolveFlaggedComment('${f.id}')">Marcar resuelto</button></div>` : `<div class="meta-row" style="margin-top:6px; font-size:12px;">Resuelto el ${f.resolved_at ? new Date(f.resolved_at).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : ''}</div>`}
        </div>
      `;}).join('') || '<div class="meta-row">sin quejas registradas para este cliente</div>'}
    `;

    // Los chips de hashtags se pintan despues de insertar el HTML (necesitan
    // que el <input type="hidden"> ya exista en el DOM).
    renderHashtagChips(`hashtags-${c.id}`);
    (planItems||[]).filter(item => item.status !== 'approved').forEach(item => renderHashtagChips(`plan-hashtags-${item.id}`));

    // Metricas: se cargan aparte (funcion propia) porque tienen su propio
    // toggle semanal/mensual y se re-renderizan solas sin recargar toda
    // la tarjeta del cliente cuando se cambia el periodo.
    renderMetrics(c.id);

    // Posts: mismo criterio que metricas -- se cachean en memoria para que
    // los filtros de estado/plataforma solo re-rendericen esta lista, sin
    // pegarle a Supabase de nuevo ni recargar toda la tarjeta.
    window.__clientPosts = window.__clientPosts || {};
    window.__clientPosts[c.id] = posts || [];
    renderPostsList(c.id);
  } else {
    const homeContainer = document.getElementById('homeList');
    if(homeContainer) homeContainer.innerHTML = '<div class="empty">sin clientes todavía</div>';
    updateArchivosHostStorageBadge([]); // sin cliente elegido, no hay nada que avisar
  } // cierra el if(c){...} — antes era el for de todos los clientes

  applyClientFilter();
}
boot();

export { boot, loadClients };
