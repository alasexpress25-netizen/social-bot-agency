// js/leads.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { sb } from "./state.js";
import { updateQuejasBadge } from "./badges.js";
import { loadClients } from "./app.js";

// Propuesta 5 (propuestas-30-07-2026.md): agrega como horario activo la
// sugerencia calculada por content_planner.py (best_times_from_scored),
// guardada en socialbot_suggested_schedule. dayOfWeekPy viene en formato
// Python weekday() (0=lunes..6=domingo); el selector de horarios usa
// 1=lunes..7=domingo, de ahí el +1.
// Punto 8 (propuestas-30-07-2026.md): al aprobar, primero se guarda el
// texto tal como haya quedado editado en el textarea (por si la agencia
// lo tocó) y recién ahí se pasa a 'approved' -- ese cambio de estado es
// lo que dispara trg_send_referral_suggestion -> send-referral-prompt,
// que manda el DM real. También sirve para "Reintentar envío" sobre una
// sugerencia en 'failed': vuelve a poner 'approved' y el trigger la
// reintenta.
async function approveReferralSuggestion(id){
  const textarea = document.getElementById(`referral-msg-${id}`);
  const message = textarea ? textarea.value : undefined;
  const update = { status: 'approved', answered_by: 'agencia', updated_at: new Date().toISOString() };
  if(message !== undefined) update.message = message;
  const { error } = await sb.from('socialbot_referral_suggestions').update(update).eq('id', id);
  if(error){ alert('No se pudo aprobar la sugerencia: ' + error.message); return; }
  loadClients();
}
async function rejectReferralSuggestion(id){
  const { error } = await sb.from('socialbot_referral_suggestions').update({ status: 'rejected', updated_at: new Date().toISOString() }).eq('id', id);
  if(error){ alert('No se pudo descartar la sugerencia: ' + error.message); return; }
  loadClients();
}
// Punto 12 (propuestas-30-07-2026.md): marca una queja/comentario negativo
// como atendido. No dispara ningún mensaje ni trigger -- es solo el
// registro de que la agencia ya lo vio y respondió por fuera del bot.
async function resolveFlaggedComment(id){
  const { error } = await sb.from('socialbot_flagged_comments').update({ status: 'resuelto', resolved_at: new Date().toISOString() }).eq('id', id);
  if(error){ alert('No se pudo marcar como resuelto: ' + error.message); return; }
  updateQuejasBadge();
  loadClients();
}
async function updateLeadStatus(leadId, status){
  await sb.from('socialbot_leads').update({ status, updated_at: new Date().toISOString() }).eq('id', leadId);
  loadClients();
}

export { approveReferralSuggestion, rejectReferralSuggestion, resolveFlaggedComment, updateLeadStatus };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.approveReferralSuggestion = approveReferralSuggestion;
window.rejectReferralSuggestion = rejectReferralSuggestion;
window.resolveFlaggedComment = resolveFlaggedComment;
window.updateLeadStatus = updateLeadStatus;
