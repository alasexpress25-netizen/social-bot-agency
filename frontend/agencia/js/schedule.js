// js/schedule.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { sb } from "./state.js";
import { loadClients } from "./app.js";

async function addSlot(e, clientId){
  e.preventDefault();
  const f = new FormData(e.target);
  const dow = f.get('day_of_week');
  await sb.from('socialbot_schedule_slots').insert({
    client_id: clientId,
    hour: parseInt(f.get('hour')),
    minute: parseInt(f.get('minute') || 0),
    day_of_week: dow ? parseInt(dow) : null,
  });
  loadClients();
}
async function saveAllSlots(e, clientId){
  e.preventDefault();
  const form = e.target;
  const cards = form.querySelectorAll('.slot-card');
  const updates = Array.from(cards).map(card => {
    const slotId = card.dataset.slotId;
    const dow = card.querySelector('[data-field="day_of_week"]').value;
    const hour = parseInt(card.querySelector('[data-field="hour"]').value);
    const minute = parseInt(card.querySelector('[data-field="minute"]').value || 0);
    const active = card.querySelector('[data-field="active"]').checked;
    return sb.from('socialbot_schedule_slots').update({
      hour,
      minute,
      day_of_week: dow ? parseInt(dow) : null,
      active,
    }).eq('id', slotId);
  });
  await Promise.all(updates);
  loadClients();
}
async function deleteSlot(slotId, clientId){
  if(!confirm('¿Eliminar este horario?')) return;
  await sb.from('socialbot_schedule_slots').delete().eq('id', slotId);
  loadClients();
}
async function useSuggestedSlot(clientId, hour, dayOfWeekPy){
  await sb.from('socialbot_schedule_slots').insert({
    client_id: clientId,
    hour,
    minute: 0,
    day_of_week: dayOfWeekPy + 1,
  });
  loadClients();
}

export { addSlot, deleteSlot, saveAllSlots, useSuggestedSlot };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.addSlot = addSlot;
window.deleteSlot = deleteSlot;
window.saveAllSlots = saveAllSlots;
window.useSuggestedSlot = useSuggestedSlot;
