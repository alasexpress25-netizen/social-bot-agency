// js/client-health.js
// Punto 7 del roadmap "mejoras-metricas-negocio-serio.md": dashboard
// consolidado multi-cliente para la agencia. Compara, para cada cliente,
// la fila mas reciente de socialbot_client_weekly_snapshots contra la
// anterior (semana vs. semana) y arma un semaforo simple:
//   verde (subieron mas metricas de las que bajaron), amarillo (empate),
//   rojo (bajaron mas de las que subieron). Metricas sin dato en alguna
//   de las 2 semanas se ignoran (no cuentan ni a favor ni en contra).
// No pide nada nuevo a Supabase que no sea la tabla de snapshots -- toda
// la data ya la puebla collect_weekly_client_snapshot() en
// scheduler/metrics_collector.py.

import { sb } from "./state.js";

const METRIC_KEYS = ['likes', 'comments', 'leads', 'leads_convertidos', 'clics_link', 'seguidores_totales', 'reach'];
const METRIC_LABELS = {
  likes: '❤️ Likes',
  comments: '💬 Comentarios',
  leads: '📩 Leads',
  leads_convertidos: '🤝 Convertidos',
  clics_link: '🔗 Clics',
  seguidores_totales: '👥 Seguidores',
  reach: '👁️ Alcance',
};
const STATUS_META = {
  rojo: { emoji: '🔴', label: 'Bajó esta semana' },
  amarillo: { emoji: '🟡', label: 'Se mantuvo' },
  verde: { emoji: '🟢', label: 'Creció' },
  'sin-datos': { emoji: '⚪', label: 'Todavía sin 2 semanas de datos para comparar' },
};
const STATUS_ORDER = { rojo: 0, amarillo: 1, verde: 2, 'sin-datos': 3 };

// clients: el mismo array que ya trajo loadClients() en app.js (no se
// vuelve a pedir a Supabase). Se llama desde ahi, una vez por carga.
async function loadClientHealth(clients){
  const badge = document.getElementById('saludBadge');
  const listEl = document.getElementById('saludList');
  if(!clients || !clients.length){
    if(badge) badge.style.display = 'none';
    if(listEl) listEl.innerHTML = '<div class="meta-row">Sin clientes todavía.</div>';
    return;
  }

  // Una sola query para TODOS los clientes de la agencia (RLS ya filtra
  // por agencia) -- mas barato que 1 query por cliente. Traemos de sobra
  // (6 semanas por cliente) para no depender de que cada cliente tenga
  // exactamente 2 filas.
  const { data: snapshots, error } = await sb
    .from('socialbot_client_weekly_snapshots')
    .select('client_id, week_start, likes, comments, leads, leads_convertidos, clics_link, seguidores_totales, reach')
    .order('week_start', { ascending: false })
    .limit(clients.length * 6);
  if(error){
    console.error('No se pudo traer el dashboard de salud de clientes', error);
    if(listEl) listEl.innerHTML = '<div class="meta-row">No se pudo cargar el dashboard de salud de clientes.</div>';
    return;
  }

  const byClient = {};
  (snapshots || []).forEach(row => {
    (byClient[row.client_id] ||= []).push(row);
  });

  const results = clients.map(client => {
    const rows = (byClient[client.id] || []).sort((a, b) => b.week_start.localeCompare(a.week_start));
    const [latest, previous] = rows;
    let status = 'sin-datos', up = 0, down = 0, same = 0, compared = 0;
    if(latest && previous){
      METRIC_KEYS.forEach(key => {
        const a = latest[key], b = previous[key];
        if(a == null || b == null) return; // sin dato esa semana para esta metrica puntual -- no cuenta
        compared++;
        if(a > b) up++;
        else if(a < b) down++;
        else same++;
      });
      if(compared > 0) status = up > down ? 'verde' : (down > up ? 'rojo' : 'amarillo');
    }
    return { client, latest, previous, status, up, down, same, compared };
  });

  results.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.client.name.localeCompare(b.client.name));

  const redCount = results.filter(r => r.status === 'rojo').length;
  const yellowCount = results.filter(r => r.status === 'amarillo').length;
  if(badge){
    if(redCount + yellowCount > 0){
      badge.textContent = `${redCount ? `🔴${redCount} ` : ''}${yellowCount ? `🟡${yellowCount}` : ''}`.trim();
      badge.style.display = 'flex';
      badge.style.alignItems = 'center';
      badge.style.justifyContent = 'center';
    } else {
      badge.style.display = 'none';
    }
  }

  if(!listEl) return;
  listEl.innerHTML = results.map(r => {
    const meta = STATUS_META[r.status];
    const rows = [r.latest, r.previous].filter(Boolean);
    return `
      <div class="card" style="margin-bottom:10px;">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:20px;">${meta.emoji}</span>
            <div>
              <div style="font-weight:600;">${r.client.name}</div>
              <div class="meta-row" style="margin:0; font-size:11px;">${meta.label}${r.compared ? ` · ${r.up} subieron, ${r.down} bajaron, ${r.same} igual (de ${r.compared} métricas comparables)` : ''}</div>
            </div>
          </div>
          <button type="button" class="secondary" style="padding:6px 12px; font-size:12px;" onclick="goToClientHealth('${r.client.id}')">Ir a la cuenta del cliente</button>
        </div>
        ${rows.length ? `
        <div style="overflow-x:auto; margin-top:10px;">
        <table style="width:100%; font-size:12px; border-collapse:collapse; min-width:520px;">
          <thead>
            <tr>
              <th style="text-align:left; padding:4px 6px; color:var(--muted); font-weight:500;">Semana</th>
              ${METRIC_KEYS.map(k => `<th style="text-align:right; padding:4px 6px; color:var(--muted); font-weight:500;">${METRIC_LABELS[k]}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map(row => `
              <tr>
                <td style="padding:4px 6px;">${row.week_start}</td>
                ${METRIC_KEYS.map(k => `<td style="text-align:right; padding:4px 6px;">${row[k] != null ? Number(row[k]).toLocaleString('es') : '—'}</td>`).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
        </div>
        ` : `<div class="meta-row" style="font-size:11px; margin-top:6px;">Necesita al menos 2 semanas cerradas para comparar (recién activado esta semana).</div>`}
      </div>
    `;
  }).join('');
}

// Reutiliza el selector de cliente + su handler ya existente (clients.js)
// para no duplicar la logica de "cambiar de cliente y refrescar todo" --
// solo simula elegirlo desde el selector de la topbar y despues cambia a
// la pestaña de Metricas.
function goToClientHealth(clientId){
  const selector = document.getElementById('clientSelector');
  if(!selector) return;
  selector.value = clientId;
  window.onClientSelectorChange();
  window.switchView('metricas');
}
window.goToClientHealth = goToClientHealth;

export { loadClientHealth };
