// js/rules.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { sb } from "./state.js";
import { loadClients } from "./app.js";

async function saveAi(e, clientId){
  e.preventDefault();
  const f = new FormData(e.target);
  await sb.from('socialbot_ai_settings').upsert({
    client_id: clientId,
    provider: f.get('provider'),
    content_plan_provider: f.get('content_plan_provider'),
    tone: f.get('tone'),
    reply_language: f.get('reply_language') || 'pt-BR',
    daily_ai_reply_limit: f.get('daily_ai_reply_limit') ? parseInt(f.get('daily_ai_reply_limit'), 10) : null,
    default_hashtags: f.get('default_hashtags'),
    topics: f.get('topics'),
    knowledge_base: f.get('knowledge_base'),
    system_prompt: f.get('system_prompt'),
  }, { onConflict: 'client_id' });
  loadClients();
}
async function addRule(e, clientId){
  e.preventDefault();
  const f = new FormData(e.target);
  await sb.from('socialbot_auto_reply_rules').insert({
    client_id: clientId,
    keyword: f.get('keyword'),
    match_type: f.get('match_type'),
    reply_template: f.get('reply_template'),
  });
  loadClients();
}
async function updateRule(e, ruleId, clientId){
  e.preventDefault();
  const f = new FormData(e.target);
  await sb.from('socialbot_auto_reply_rules').update({
    keyword: f.get('keyword'),
    match_type: f.get('match_type'),
    reply_template: f.get('reply_template'),
  }).eq('id', ruleId);
  loadClients();
}
async function deleteRule(ruleId, clientId){
  if(!confirm('¿Eliminar esta regla?')) return;
  await sb.from('socialbot_auto_reply_rules').delete().eq('id', ruleId);
  loadClients();
}

export { addRule, deleteRule, saveAi, updateRule };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.addRule = addRule;
window.deleteRule = deleteRule;
window.saveAi = saveAi;
window.updateRule = updateRule;
