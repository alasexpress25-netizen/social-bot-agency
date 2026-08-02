// js/hashtags.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

// ---------------------------------------------------------------------------
// Editor de hashtags reutilizable (chips con boton de borrar + input para
// agregar). Los hashtags se guardan como texto separado por espacios (mismo
// formato que ya usa content_planner.py / socialbot_ai_settings.default_hashtags
// / socialbot_content_plan_items.hashtags), en un <input type="hidden"> que
// despues cada form/boton "Guardar" lee y persiste en Supabase.
// ---------------------------------------------------------------------------
function hashtagsToArray(str){
  return (str||'').split(/\s+/).map(t => t.trim()).filter(Boolean).map(t => t.startsWith('#') ? t : '#'+t);
}
function hashtagEditorHtml(fieldId, hashtagsStr){
  return `
    <input type="hidden" name="default_hashtags" id="${fieldId}" value="${(hashtagsStr||'').replace(/"/g,'&quot;')}" />
    <div class="hashtag-row" id="${fieldId}-chips"></div>
    <div class="hashtag-add-row">
      <input type="text" id="${fieldId}-input" aria-label="Agregar hashtag" placeholder="Agregar hashtag (ej: marketing)"
        onkeydown="if(event.key==='Enter'){ event.preventDefault(); addHashtag('${fieldId}'); }" />
      <button type="button" class="secondary" onclick="addHashtag('${fieldId}')">+ Agregar</button>
    </div>`;
}
function renderHashtagChips(fieldId){
  const hidden = document.getElementById(fieldId);
  const chipsEl = document.getElementById(`${fieldId}-chips`);
  if(!hidden || !chipsEl) return;
  const tags = hashtagsToArray(hidden.value);
  chipsEl.innerHTML = tags.map(t => `
    <span class="hashtag-chip">${t}<button type="button" title="Quitar" onclick="removeHashtag('${fieldId}', '${t.replace(/'/g,"\\'")}')">&times;</button></span>
  `).join('') || '<span class="meta-row" style="margin-top:0;">sin hashtags todavía</span>';
}
function addHashtag(fieldId){
  const input = document.getElementById(`${fieldId}-input`);
  let val = (input.value || '').trim();
  if(!val) return;
  if(!val.startsWith('#')) val = '#' + val;
  val = val.replace(/\s+/g, '');
  const hidden = document.getElementById(fieldId);
  const tags = hashtagsToArray(hidden.value);
  if(!tags.includes(val)) tags.push(val);
  hidden.value = tags.join(' ');
  input.value = '';
  renderHashtagChips(fieldId);
}
function removeHashtag(fieldId, tag){
  const hidden = document.getElementById(fieldId);
  hidden.value = hashtagsToArray(hidden.value).filter(t => t !== tag).join(' ');
  renderHashtagChips(fieldId);
}

export { addHashtag, hashtagEditorHtml, hashtagsToArray, removeHashtag, renderHashtagChips };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.addHashtag = addHashtag;
window.removeHashtag = removeHashtag;
