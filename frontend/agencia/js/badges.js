// js/badges.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { sb, selectedClientId } from "./state.js";

// Badge tipo "WhatsApp Web" en el ícono de Plan del sidebar: cuenta los
// items del plan semanal (socialbot_content_plan_items) en status='proposed'
// -- es decir, generados por la IA y todavía sin revisar -- del cliente
// actualmente seleccionado en el selector de arriba (selectedClientId).
async function updatePlanBadge(){
  const badge = document.getElementById('planBadge');
  if(!badge) return;
  if(!selectedClientId){ setBadgeCount(badge, 0); return; }
  const { count, error } = await sb.from('socialbot_content_plan_items').select('id', { count:'exact', head:true }).eq('status', 'proposed').eq('client_id', selectedClientId);
  if(error){ console.error('No se pudo traer el conteo del plan sin aprobar', error); return; }
  setBadgeCount(badge, count);
}
// Badge tipo "WhatsApp Web" en el ícono de Leads del sidebar: cuenta los
// leads en status='nuevo' del cliente actualmente seleccionado en el
// selector de arriba (selectedClientId).
async function updateLeadsBadge(){
  const badge = document.getElementById('leadsBadge');
  if(!badge) return;
  if(!selectedClientId){ setBadgeCount(badge, 0); return; }
  const { count, error } = await sb.from('socialbot_leads').select('id', { count:'exact', head:true }).eq('status', 'nuevo').eq('client_id', selectedClientId);
  if(error){ console.error('No se pudo traer el conteo de leads nuevos', error); return; }
  setBadgeCount(badge, count);
}
// Badge de "Referidos": cuenta las sugerencias en status='proposed' del
// cliente seleccionado -- son las que esperan revisión/aprobación de la
// agencia (punto 8 de propuestas-30-07-2026.md).
async function updateReferidosBadge(){
  const badge = document.getElementById('referidosBadge');
  if(!badge) return;
  if(!selectedClientId){ setBadgeCount(badge, 0); return; }
  const { count, error } = await sb.from('socialbot_referral_suggestions').select('id', { count:'exact', head:true }).eq('status', 'proposed').eq('client_id', selectedClientId);
  if(error){ console.error('No se pudo traer el conteo de referidos pendientes', error); return; }
  setBadgeCount(badge, count);
}
// Punto 12 (propuestas-30-07-2026.md): cuenta las quejas/comentarios
// negativos (socialbot_flagged_comments) todavía en status='pendiente'
// del cliente seleccionado -- mismo patrón que el resto de los badges.
async function updateQuejasBadge(){
  const badge = document.getElementById('quejasBadge');
  if(!badge) return;
  if(!selectedClientId){ setBadgeCount(badge, 0); return; }
  const { count, error } = await sb.from('socialbot_flagged_comments').select('id', { count:'exact', head:true }).eq('status', 'pendiente').eq('client_id', selectedClientId);
  if(error){ console.error('No se pudo traer el conteo de quejas pendientes', error); return; }
  setBadgeCount(badge, count);
}
// Helper compartido: muestra/oculta un badge numérico según el conteo,
// recortando a "99+" para que no rompa el layout del ícono.
function setBadgeCount(badge, count){
  if(count && count > 0){
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.style.display = 'flex';
    badge.style.alignItems = 'center';
    badge.style.justifyContent = 'center';
  } else {
    badge.style.display = 'none';
  }
}
// Badge tipo "WhatsApp Web" en el ícono de Clientes del sidebar: cuenta los
// posts en approval_status='pending' (normalmente los aprueba el cliente
// desde su portal, pero la agencia también puede hacerlo desde la ficha
// del cliente en esta misma pestaña) del cliente actualmente seleccionado
// en el selector de arriba (selectedClientId).
async function updateClientesBadge(){
  const badge = document.getElementById('clientesBadge');
  if(!badge) return;
  if(!selectedClientId){ setBadgeCount(badge, 0); return; }
  const { count, error } = await sb.from('socialbot_posts').select('id', { count:'exact', head:true }).eq('approval_status', 'pending').eq('client_id', selectedClientId);
  if(error){ console.error('No se pudo traer el conteo de posts pendientes de aprobación', error); return; }
  setBadgeCount(badge, count);
}

export { setBadgeCount, updateClientesBadge, updateLeadsBadge, updatePlanBadge, updateQuejasBadge, updateReferidosBadge };
