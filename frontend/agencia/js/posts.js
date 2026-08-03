// js/posts.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { PLATFORM_META_AG, sb } from "./state.js";
import { loadClients } from "./app.js";

async function publishNow(clientId, clientName){
  if(!confirm(`¿Disparar una publicación manual para ${clientName} ahora mismo? Va a generar (o reintentar) un post para cada horario activo de este cliente, sin esperar su horario programado.`)) return;
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = 'Disparando...';
  try {
    const { data, error } = await sb.functions.invoke('trigger-manual-publish', { body: { client_id: clientId } });
    if(error){ throw error; }
    if(data && data.error){ throw new Error(data.error); }
    alert(`Listo, se disparó el workflow para ${clientName}. Puede tardar 1-2 minutos en verse el resultado — revisá la pestaña Actions de GitHub, o volvé a entrar acá en un rato para ver el post nuevo.`);
  } catch(err){
    alert(`No se pudo disparar: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Publicar ahora';
  }
}
async function publishMediaNow(mediaId, clientId, clientName){
  if(!confirm(`¿Publicar este medio puntual de ${clientName} ahora mismo? Se va a usar ESTE medio (no el que le tocaría por rotación) en todas las cuentas conectadas del cliente.`)) return;
  const btn = event.target;
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = 'Disparando...';
  try {
    const { data, error } = await sb.functions.invoke('trigger-manual-publish', { body: { client_id: clientId, media_id: mediaId } });
    if(error){ throw error; }
    if(data && data.error){ throw new Error(data.error); }
    alert(`Listo, se disparó el workflow para ${clientName} con este medio. Puede tardar 1-2 minutos en verse el resultado — revisá la pestaña Actions de GitHub, o volvé a entrar acá en un rato para ver el post nuevo.`);
  } catch(err){
    alert(`No se pudo disparar: ${err.message || err}`);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}
function postDateKey(p){
  const iso = p.published_at || p.created_at;
  return iso ? iso.slice(0, 10) : null; // YYYY-MM-DD, agnostico a la hora
}
function populateDateFilterOptions(selectEl, posts){
  if(!selectEl) return;
  const previousValue = selectEl.value || 'all';
  const dates = [...new Set(posts.map(postDateKey).filter(Boolean))].sort().reverse();
  selectEl.innerHTML = `<option value="all">Todas las fechas</option>` +
    dates.map(d => {
      const label = new Date(d + 'T00:00:00').toLocaleDateString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric' });
      return `<option value="${d}">${label}</option>`;
    }).join('');
  // Si la fecha elegida sigue existiendo en la lista, la mantenemos
  // seleccionada (para no perder el filtro al reintentar un post, por ej.).
  if(dates.includes(previousValue) || previousValue === 'all'){
    selectEl.value = previousValue;
  }
}
function renderPostsList(clientId){
  const all = (window.__clientPosts && window.__clientPosts[clientId]) || [];
  const statusFilter = document.getElementById(`postsFilterStatus-${clientId}`)?.value || 'all';
  const platformFilter = document.getElementById(`postsFilterPlatform-${clientId}`)?.value || 'all';

  const dateSelectEl = document.getElementById(`postsFilterDate-${clientId}`);
  populateDateFilterOptions(dateSelectEl, all);
  const dateFilter = dateSelectEl?.value || 'all';

  const filtered = all.filter(p => {
    if(statusFilter !== 'all' && p.status !== statusFilter) return false;
    if(platformFilter !== 'all' && p.platform !== platformFilter) return false;
    if(dateFilter !== 'all' && postDateKey(p) !== dateFilter) return false;
    return true;
  });

  const container = document.getElementById(`posts-list-${clientId}`);
  if(!container) return;

  if(filtered.length === 0){
    container.innerHTML = `<div class="empty">${all.length === 0 ? 'todavía no hay publicaciones' : 'ninguna publicación coincide con el filtro'}</div>`;
    return;
  }

  container.innerHTML = filtered.map(p => {
    const platform = p.platform;
    const pMeta = PLATFORM_META_AG[platform];
    const dateLabel = (p.published_at || p.created_at) ? new Date(p.published_at || p.created_at).toLocaleString('es-AR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    return `
      <div class="card" style="margin-top:8px; padding:10px 12px;">
        <div class="meta-row" style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <span class="status-${p.status}" style="font-weight:600;">[${p.status}]</span>
          ${pMeta ? `<span>${pMeta.icon} ${pMeta.label}</span>` : ''}
          ${dateLabel ? `<span style="color:var(--muted); font-weight:600; font-size:12px;">${dateLabel}</span>` : ''}
        </div>
        <div style="margin-top:4px;">${(p.caption||'').slice(0,80)}...</div>
        ${renderPostMetricsChips(p)}
        ${p.status==='failed' && p.error_message ? `<div style="margin-top:4px; font-size:12px; color:var(--warn); font-weight:600;">${p.error_message.slice(0,160)}</div>` : ''}
        <div style="margin-top:6px; display:flex; gap:12px; align-items:center;">
          ${p.permalink_url ? `<a href="${p.permalink_url}" target="_blank" rel="noopener" style="font-size:12px; color:var(--white); text-decoration:underline; display:inline-flex; align-items:center; gap:4px;">Ver publicación<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></a>` : ''}
          ${p.status==='failed' ? `<button type="button" class="secondary" style="padding:4px 10px; font-size:12px;" onclick="retryPost('${p.id}', '${clientId}')">Reintentar</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}
// Actualización 03/08/2026 (actualizacion_posts_y_metricas.txt, Parte 1,
// cambio 2): chip de métricas por post, solo para publicados y con fila en
// socialbot_post_metrics (metrics_collector.py puede no haber pasado
// todavía por este post, en cuyo caso socialbot_post_metrics viene null
// -- en ese caso no se muestra nada, no un "—" en cada campo).
function renderPostMetricsChips(p){
  if(p.status !== 'published') return '';
  // Supabase devuelve la relación embebida como array (join 1-a-muchos a
  // nivel de tipos), aunque acá siempre haya 0 o 1 fila por post.
  const m = Array.isArray(p.socialbot_post_metrics) ? p.socialbot_post_metrics[0] : p.socialbot_post_metrics;
  if(!m) return '';
  const parts = [];
  if(m.plays != null){
    parts.push(`▶️ ${m.plays} reproducciones`);
  } else {
    parts.push(`👁 ${m.reach ?? '—'}`);
  }
  parts.push(`❤️ ${m.likes ?? '—'}`);
  parts.push(`💬 ${m.comments ?? '—'}`);
  parts.push(`🔁 ${m.shares ?? '—'}`);
  parts.push(`📌 ${m.saved ?? '—'}`);
  // Parte 1, punto 3 (actualizacion_posts_y_metricas.txt): alcance a
  // no-seguidores por post -- esto SI existe en la API de Meta, a
  // diferencia de "nuevos seguidores por post" (que no existe y queda
  // afuera por decision del cliente).
  if(m.non_follower_reach != null){
    parts.push(`🎯 alcanzó a ${m.non_follower_reach} no-seguidores`);
  }
  return `<div style="margin-top:6px; font-size:12px; color:var(--muted);">${parts.join(' · ')}</div>`;
}
async function retryPost(postId, clientId){
  if(!confirm('¿Reintentar esta publicación? Se va a volver a intentar publicar en el próximo ciclo del scheduler.')) return;
  const { error } = await sb.from('socialbot_posts').update({
    status: 'pending', approval_status: 'approved', error_message: null,
  }).eq('id', postId);
  if(error){ alert('Error al reintentar: ' + error.message); return; }

  // Actualiza el cache en memoria (sin recargar todo el cliente) para que
  // el cambio se vea al toque en la lista.
  const cached = (window.__clientPosts && window.__clientPosts[clientId]) || [];
  const idx = cached.findIndex(p => p.id === postId);
  if(idx !== -1){ cached[idx].status = 'pending'; cached[idx].error_message = null; }
  renderPostsList(clientId);
}
// ---------------------------------------------------------------------------
// FASE 5: la agencia tambien puede aprobar/rechazar (y editar el texto de)
// un post pendiente, ademas del cliente desde su propio portal. No hace
// falta ninguna funcion RPC especial para esto (a diferencia del cliente):
// la agencia ya tiene UPDATE directo sobre estas filas via la policy
// "owner sees own posts" (0001_init.sql, "for all"). El scheduler publica
// lo aprobado en la siguiente corrida sin importar quien lo aprobo.
// ---------------------------------------------------------------------------
async function reviewPostAsAgency(postId, decision){
  const { error } = await sb.from('socialbot_posts').update({ approval_status: decision }).eq('id', postId);
  if(error){ alert(error.message); return; }
  loadClients();
}
// Aprueba de una todos los posts pendientes de este cliente (sin tildar nada).
async function approveAllPending(clientId){
  const ids = Array.from(document.querySelectorAll(`[data-client-pending="${clientId}"] .pending-check`)).map(cb => cb.dataset.postId);
  if(!ids.length) return;
  if(!confirm(`¿Aprobar los ${ids.length} post(s) pendientes de este cliente?`)) return;
  const { error } = await sb.from('socialbot_posts').update({ approval_status: 'approved' }).in('id', ids);
  if(error){ alert(error.message); return; }
  loadClients();
}
// Aprueba solo los posts que el usuario tildó con el checkbox de cada tarjeta.
async function approveSelectedPending(clientId){
  const ids = Array.from(document.querySelectorAll(`[data-client-pending="${clientId}"] .pending-check:checked`)).map(cb => cb.dataset.postId);
  if(!ids.length){ alert('No tildaste ningún post.'); return; }
  const { error } = await sb.from('socialbot_posts').update({ approval_status: 'approved' }).in('id', ids);
  if(error){ alert(error.message); return; }
  loadClients();
}
async function saveCaptionAsAgency(postId){
  const value = document.getElementById(`agency-caption-${postId}`).value;
  const { error } = await sb.from('socialbot_posts').update({ caption: value }).eq('id', postId);
  if(error){ alert(error.message); return; }
  alert('Texto guardado.');
}

export { approveAllPending, approveSelectedPending, populateDateFilterOptions, postDateKey, publishMediaNow, publishNow, renderPostsList, retryPost, reviewPostAsAgency, saveCaptionAsAgency };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.approveAllPending = approveAllPending;
window.approveSelectedPending = approveSelectedPending;
window.publishMediaNow = publishMediaNow;
window.renderPostsList = renderPostsList;
window.retryPost = retryPost;
window.reviewPostAsAgency = reviewPostAsAgency;
window.saveCaptionAsAgency = saveCaptionAsAgency;
