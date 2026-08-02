// js/archivos-host.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { CLIENT_STORAGE_LIMIT_MB, CLIENT_STORAGE_WARN_MB, UPLOAD_ENDPOINT, UPLOAD_TOKEN, archivosHostFilesByUrl, archivosHostFolder, clientsCache, sb, selectedClientId, setArchivosHostFilesByUrl, setArchivosHostFolder } from "./state.js";
import { switchView } from "./ui-chrome.js";
import { toggleMediaTypeFields } from "./media.js";

// Devuelve { limitMb, warnMb } para el cliente actualmente elegido, tomando
// los valores guardados en Supabase (clientsCache, cargado por loadClients())
// y cayendo a las constantes de arriba si todavía no están seteados.
function getArchivosHostStorageLimits(){
  const cached = clientsCache[selectedClientId];
  const client = cached && cached.client;
  const limitMb = (client && client.storage_limit_mb) || CLIENT_STORAGE_LIMIT_MB;
  const warnMb = (client && client.storage_warn_mb) || CLIENT_STORAGE_WARN_MB;
  return { limitMb, warnMb };
}
// ---------------------------------------------------------------------------
// Pestaña "Archivos en Host" -- subida de archivos (imágenes y/o videos
// mezclados, los que se quieran de una), directo a R2 en 2 pasos:
//   1) le pedimos a la Edge Function una URL prefirmada de subida (esta
//      función nunca ve los bytes del archivo -- evita el límite de memoria
//      de Edge Functions, 256MB, contra videos de hasta 100MB).
//   2) subimos el archivo DIRECTO a esa URL (browser -> R2, sin pasar por
//      Supabase ni por Hostinger).
// Esta subida no arma carrusel por sí sola: al terminar solo refresca la
// lista de abajo. El carrusel se arma tildando 2+ imágenes en esa lista y
// usando "Usar como Carrusel" (ver onArchivosHostCheckChange /
// useSelectedArchivosHostInMedios más abajo) -- un solo filtro, un solo
// lugar donde se decide qué se puede armar con lo tildado.
// ---------------------------------------------------------------------------
async function uploadFilesToArchivosHost(e){
  e.preventDefault();
  if(!selectedClientId){ alert('Elegí un cliente en el selector de arriba primero.'); return; }

  // Chequeo de límite (storage_limit_mb del cliente, ver "Ajustar límites de
  // este cliente" más arriba): si ya lo pasó, no lo dejamos subir más hasta
  // que borre algo o suba el límite manualmente. Nos aseguramos de tener el
  // dato fresco de ESTE cliente antes de decidir -- si el usuario recién
  // entró y todavía no se calculó nada, o cambió de cliente, lo volvemos a
  // pedir.
  if(!window.__archivosHostStorage || window.__archivosHostStorage.clientId !== selectedClientId){
    await updateArchivosHostStorageBadge();
  }
  const storage = window.__archivosHostStorage;
  if(storage && storage.overLimit){
    alert(`Este cliente ya usa ${storage.totalMb.toFixed(0)}MB, superó su límite de ${storage.limitMb}MB. Borrá algo en la lista de abajo o subí el límite del cliente antes de cargar archivos nuevos.`);
    return;
  }

  const input = document.getElementById('archivosHostFileInput');
  const files = Array.from(input.files || []);
  if(files.length === 0){ alert('Elegí uno o varios archivos primero.'); return; }

  const btn = document.getElementById('archivosHostFileSubmitBtn');
  const progress = document.getElementById('archivosHostFileProgressMsg');
  btn.disabled = true;
  progress.style.display = '';

  const folder = selectedClientId; // guardamos el cliente de ESTE momento, por si cambian el selector antes de que termine el lote
  const errors = [];
  let okCount = 0;

  // Subimos una por una (no en paralelo): con videos de hasta 100MB c/u,
  // mandarlas todas juntas satura el ancho de banda del que está subiendo y
  // hace que todas tarden más en vez de menos.
  for(let i = 0; i < files.length; i++){
    const file = files[i];
    const counter = files.length > 1 ? ` (${i + 1}/${files.length})` : '';
    progress.textContent = `Preparando subida de ${file.name}${counter}...`;

    try{
      const presignRes = await fetch(UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: { 'X-Upload-Token': UPLOAD_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'presign-upload', folder, filename: file.name, size: file.size })
      });
      const presignData = await presignRes.json().catch(() => ({}));
      if(!presignRes.ok || presignData.error){ throw new Error(presignData.error || `Error del servidor (${presignRes.status})`); }

      progress.textContent = `Subiendo ${file.name}${counter}...`;
      const putRes = await fetch(presignData.uploadUrl, { method: 'PUT', body: file });
      if(!putRes.ok){ throw new Error(`No se pudo subir el archivo a R2 (${putRes.status})`); }

      okCount++;
    }catch(err){
      errors.push(`${file.name}: ${err.message}`);
    }
  }

  input.value = '';
  btn.disabled = false;
  progress.style.display = 'none';

  if(okCount > 0) await loadArchivosHost(); // refresca la lista (y el badge de espacio) con lo recién subido

  if(errors.length){
    alert(`${errors.length} de ${files.length} archivo(s) no se pudieron subir:\n\n` + errors.join('\n'));
  }
}
// Salta a "Medios", deja "Carrusel" preseleccionado en "Agregar medio nuevo"
// y pega las URLs recibidas en el textarea de carrusel, en el orden dado.
// Usado por useSelectedArchivosHostInMedios (imágenes tildadas de la lista
// de "Archivos en Host") más abajo.
function sendUrlsToMediosCarousel(urls){
  switchView('medios');
  const typeSelect = document.getElementById('newMediaTypeSelect');
  if(typeSelect){
    typeSelect.value = 'carousel';
    toggleMediaTypeFields(typeSelect);
  }
  const form = typeSelect ? typeSelect.closest('form') : null;
  const carouselTextarea = form ? form.querySelector('[name="carousel_urls"]') : document.querySelector('#view-medios [name="carousel_urls"]');
  if(carouselTextarea){
    carouselTextarea.value = urls.join('\n');
    carouselTextarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}
// Salta a la pestaña "Medios" y deja la URL ya cargada en el formulario
// "Agregar medio nuevo", con el tipo de medio correcto preseleccionado,
// para no tener que copiar/pegar a mano. La usa useSelectedArchivosHostInMedios
// (ver más abajo) cuando se tilda un solo archivo en "Archivos en Host".
function useUploadUrlInMedios(url, mediaType){
  switchView('medios');
  const urlInput = document.getElementById('newMediaUrlInput');
  const typeSelect = document.getElementById('newMediaTypeSelect');
  if(urlInput) urlInput.value = url;
  if(typeSelect && (mediaType === 'video' || mediaType === 'image')){
    typeSelect.value = mediaType;
    toggleMediaTypeFields(typeSelect);
  }
  if(urlInput) urlInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
async function loadArchivosHost(){
  const list = document.getElementById('archivosHostList');
  const msg = document.getElementById('archivosHostMsg');
  const refreshBtn = document.getElementById('archivosHostRefreshBtn');
  const toolbar = document.getElementById('archivosHostToolbar');

  setArchivosHostFilesByUrl({});
  toolbar.innerHTML = '';

  if(!selectedClientId){
    list.innerHTML = '';
    msg.style.display = '';
    msg.textContent = 'Elegí un cliente en el selector de arriba primero.';
    updateArchivosHostStorageBadge([]);
    return;
  }

  refreshBtn.disabled = true;
  msg.style.display = '';
  msg.textContent = 'Cargando archivos...';
  list.innerHTML = '';

  try{
    const folder = selectedClientId;
    setArchivosHostFolder(folder);

    const res = await fetch(UPLOAD_ENDPOINT, {
      method: 'POST',
      headers: { 'X-Upload-Token': UPLOAD_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list', folder })
    });
    const data = await res.json().catch(() => ({}));
    if(!res.ok || data.error){ throw new Error(data.error || `Error del servidor (${res.status})`); }

    const files = data.files || [];
    if(files.length === 0){
      msg.textContent = 'No hay archivos subidos todavía para este cliente.';
    } else {
      msg.style.display = 'none';
      files.forEach(f => { archivosHostFilesByUrl[f.url] = f; });
      renderArchivosHostToolbar(toolbar);
      files.forEach(f => list.appendChild(renderArchivosHostRow(f)));
      onArchivosHostCheckChange(); // arranca todo destildado y los botones deshabilitados
    }
    updateArchivosHostStorageBadge(files);
  }catch(err){
    msg.textContent = 'No se pudo cargar la lista: ' + err.message;
  }finally{
    refreshBtn.disabled = false;
  }
}
// Suma el peso de los archivos del cliente elegido, prende/apaga el
// triangulito de advertencia sobre el ícono "Archivos en Host" del sidebar
// (igual que updateClientesBadge() hace con leads pendientes) y pinta el
// resumen/barra/inputs dentro de esa pestaña. Amarillo desde el
// storage_warn_mb del cliente, rojo desde su storage_limit_mb -- ambos
// editables por cliente (ver saveArchivosHostLimits) con las constantes
// CLIENT_STORAGE_LIMIT_MB / CLIENT_STORAGE_WARN_MB como respaldo si el
// cliente todavía no los tiene seteados.
//
// Guarda el total en window.__archivosHostStorage para que
// uploadFilesToArchivosHost() pueda bloquear
// la subida sin tener que volver a pedir el listado.
//
// Se llama desde loadClients() (cada vez que cambiás de cliente en el
// selector de arriba, igual que el resto de los badges) para que el aviso
// aparezca sin necesidad de entrar a la pestaña. Ahí solo se pide el
// listado, así que consume poco -- un fetch por cambio de cliente, no algo
// continuo en segundo plano.
//
// Si ya tenés la lista de archivos a mano (por ej. loadArchivosHost() recién
// la trajo), pasala en `files` para evitar pedirla dos veces.
async function updateArchivosHostStorageBadge(files){
  const badge = document.getElementById('archivosHostStorageBadge');
  const summaryEl = document.getElementById('archivosHostStorageSummary');
  const barFillEl = document.getElementById('archivosHostStorageBarFill');
  const warnMsgEl = document.getElementById('archivosHostStorageWarnMsg');
  const warnInput = document.getElementById('archivosHostWarnInput');
  const limitInput = document.getElementById('archivosHostLimitInput');

  if(!selectedClientId){
    if(badge) badge.style.display = 'none';
    if(summaryEl) summaryEl.textContent = '';
    if(barFillEl) barFillEl.style.width = '0%';
    if(warnMsgEl) warnMsgEl.style.display = 'none';
    window.__archivosHostStorage = null;
    return;
  }

  if(files === undefined){
    try{
      const res = await fetch(UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: { 'X-Upload-Token': UPLOAD_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'list', folder: selectedClientId })
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok || data.error) throw new Error(data.error || `Error del servidor (${res.status})`);
      files = data.files || [];
    }catch(err){
      console.error('No se pudo calcular el espacio usado por el cliente', err);
      return; // dejamos todo como estaba, no lo apagamos por un error de red puntual
    }
  }

  const { limitMb, warnMb } = getArchivosHostStorageLimits();
  const totalBytes = (files || []).reduce((sum, f) => sum + (f.size || 0), 0);
  const totalMb = totalBytes / 1024 / 1024;
  const overLimit = totalMb >= limitMb;

  // Guardado para que uploadFilesToArchivosHost() pueda chequear el límite
  // antes de subir, sin depender de que el usuario haya entrado a esta
  // pestaña.
  window.__archivosHostStorage = { clientId: selectedClientId, totalMb, limitMb, warnMb, overLimit };

  // Triangulito del sidebar
  if(badge){
    if(totalMb < warnMb){
      badge.style.display = 'none';
    } else {
      badge.style.display = '';
      badge.classList.toggle('over-limit', overLimit);
      badge.title = overLimit
        ? `¡Atención! Este cliente ya usa ${totalMb.toFixed(0)}MB, superó el límite de ${limitMb}MB.`
        : `Este cliente usa ${totalMb.toFixed(0)}MB, se está acercando al límite de ${limitMb}MB.`;
    }
  }

  // Resumen + barra + inputs dentro de "Archivos en Host" (si la pestaña
  // está montada en el DOM en este momento -- si no, simplemente no hace
  // nada, se pinta sola la próxima vez que loadArchivosHost() la abra).
  if(summaryEl){
    summaryEl.textContent = `${totalMb.toFixed(0)} MB usados de ${limitMb} MB`;
  }
  if(barFillEl){
    const pct = Math.min(100, (totalMb / limitMb) * 100);
    barFillEl.style.width = pct + '%';
    barFillEl.style.background = overLimit ? 'var(--warn)' : (totalMb >= warnMb ? '#f0b429' : 'var(--gold)');
  }
  if(warnMsgEl){
    if(overLimit){
      warnMsgEl.style.display = '';
      warnMsgEl.textContent = `⚠️ Este cliente superó el límite de ${limitMb}MB. No se pueden subir archivos nuevos hasta borrar algo o subir el límite.`;
    } else if(totalMb >= warnMb){
      warnMsgEl.style.display = '';
      warnMsgEl.textContent = `⚠️ Cerca del límite de ${limitMb}MB.`;
    } else {
      warnMsgEl.style.display = 'none';
    }
  }
  // Solo pisamos los inputs si no están siendo editados ahora mismo (evita
  // pelearle al usuario el valor mientras está escribiendo un número nuevo).
  if(warnInput && document.activeElement !== warnInput) warnInput.value = warnMb;
  if(limitInput && document.activeElement !== limitInput) limitInput.value = limitMb;
}
// Guarda storage_limit_mb / storage_warn_mb para el cliente elegido (botón
// "Guardar" dentro de "Ajustar límites de este cliente"). Actualiza
// clientsCache al toque para que getArchivosHostStorageLimits() ya vea el
// valor nuevo sin tener que recargar todo con loadClients().
async function saveArchivosHostLimits(){
  if(!selectedClientId){ alert('Elegí un cliente en el selector de arriba primero.'); return; }

  const warnInput = document.getElementById('archivosHostWarnInput');
  const limitInput = document.getElementById('archivosHostLimitInput');
  const warnMb = parseInt(warnInput.value, 10);
  const limitMb = parseInt(limitInput.value, 10);

  if(!Number.isFinite(warnMb) || !Number.isFinite(limitMb) || warnMb <= 0 || limitMb <= 0){
    alert('Ingresá números válidos mayores a 0 para el aviso y el límite.');
    return;
  }
  if(warnMb > limitMb){
    alert('El aviso (MB) no puede ser mayor que el límite máximo.');
    return;
  }

  const { error } = await sb.from('socialbot_clients')
    .update({ storage_warn_mb: warnMb, storage_limit_mb: limitMb })
    .eq('id', selectedClientId);
  if(error){ alert('No se pudieron guardar los límites: ' + error.message); return; }

  if(clientsCache[selectedClientId]){
    clientsCache[selectedClientId].client.storage_warn_mb = warnMb;
    clientsCache[selectedClientId].client.storage_limit_mb = limitMb;
  }
  updateArchivosHostStorageBadge(); // repinta todo (badge, barra, resumen) con los valores nuevos
}
// Barra de acciones en lote: un solo Copiar/Compartir/Usar en Medios/Eliminar
// para todo lo que esté tildado, en vez de repetir los 4 botones por fila.
function renderArchivosHostToolbar(toolbar){
  toolbar.innerHTML = `
    <div class="card">
      <label style="display:flex; align-items:center; gap:8px; font-size:13px; color:var(--muted); cursor:pointer;">
        <input type="checkbox" id="archivosHostSelectAll" aria-label="Seleccionar todos los archivos" onchange="toggleSelectAllArchivosHost(this)" />
        <span id="archivosHostSelectedCount">0 seleccionados</span>
      </label>
      <div class="btn-row" style="margin-top:10px;">
        <button type="button" class="secondary" id="archivosHostCopyBtn" onclick="copySelectedArchivosHost(this)" disabled>Copiar</button>
        ${navigator.share ? '<button type="button" class="secondary" id="archivosHostShareBtn" onclick="shareSelectedArchivosHost()" disabled>Compartir</button>' : ''}
        <button type="button" id="archivosHostUseBtn" onclick="useSelectedArchivosHostInMedios()" disabled>Usar en Medios</button>
        <button type="button" class="reject" id="archivosHostDeleteBtn" onclick="deleteSelectedArchivosHost()" disabled>Eliminar</button>
      </div>
    </div>
  `;
}
// Fila con checkbox (ya no tiene sus propios botones — esos ahora viven en
// la barra de arriba y actúan sobre todo lo tildado).
function renderArchivosHostRow(file){
  const row = document.createElement('div');
  row.className = 'card';
  const sizeMb = (file.size / 1024 / 1024).toFixed(2);
  const fecha = file.mtime ? new Date(file.mtime * 1000).toLocaleString('es-AR') : '';
  const safeId = (file.url || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  row.innerHTML = `
    <div style="display:flex; align-items:flex-start; gap:10px;">
      <input type="checkbox" id="archivosHostCheck-${safeId}" name="archivosHostCheck-${safeId}" aria-label="Seleccionar ${file.name}" class="archivos-host-check" data-url="${file.url}" onchange="onArchivosHostCheckChange()" style="margin-top:4px; flex-shrink:0;" />
      <div style="flex:1; min-width:0;">
        <div class="meta-row">${file.media_type === 'video' ? 'Video' : 'Imagen'} · ${sizeMb} MB · ${fecha}</div>
        <input type="text" id="archivosHostName-${safeId}" name="archivosHostName-${safeId}" aria-label="Nombre del archivo" readonly value="${file.name}" title="${file.url}" onclick="this.select()" style="margin-top:6px; width:100%; box-sizing:border-box; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font-size:13px; font-family:inherit; background:var(--dark); color:var(--white);" />
      </div>
    </div>
  `;
  return row;
}
// Recalcula qué está tildado, actualiza el contador, el estado del checkbox
// "Seleccionar todos" (incluído el estado indeterminado) y habilita/deshabilita
// cada botón de la barra según cuántos archivos hay tildados.
function onArchivosHostCheckChange(){
  const checks = Array.from(document.querySelectorAll('.archivos-host-check'));
  const checked = checks.filter(c => c.checked);
  const n = checked.length;

  const countEl = document.getElementById('archivosHostSelectedCount');
  if(countEl) countEl.textContent = n + (n === 1 ? ' seleccionado' : ' seleccionados');

  const copyBtn = document.getElementById('archivosHostCopyBtn');
  const shareBtn = document.getElementById('archivosHostShareBtn');
  const useBtn = document.getElementById('archivosHostUseBtn');
  const deleteBtn = document.getElementById('archivosHostDeleteBtn');
  if(copyBtn) copyBtn.disabled = n === 0;
  if(shareBtn) shareBtn.disabled = n === 0;
  if(deleteBtn) deleteBtn.disabled = n === 0;

  // Con 1 tildado: manda ese archivo puntual (imagen o video) a "Medios".
  // Con 2 o más: solo tiene sentido si son todas imágenes (para armar un
  // carrusel) y no más de 10 -- el botón cambia de texto para dejarlo claro.
  if(useBtn){
    if(n === 0){
      useBtn.disabled = true;
      useBtn.textContent = 'Usar en Medios';
    } else if(n === 1){
      useBtn.disabled = false;
      useBtn.textContent = 'Usar en Medios';
    } else {
      const selectedFiles = checked.map(c => archivosHostFilesByUrl[c.dataset.url]).filter(Boolean);
      const allImages = selectedFiles.length === n && selectedFiles.every(f => f.media_type !== 'video');
      useBtn.disabled = !allImages || n > 10;
      useBtn.textContent = 'Usar como Carrusel';
    }
  }

  const selectAll = document.getElementById('archivosHostSelectAll');
  if(selectAll && checks.length > 0){
    selectAll.checked = n === checks.length;
    selectAll.indeterminate = n > 0 && n < checks.length;
  }
}
function toggleSelectAllArchivosHost(cb){
  document.querySelectorAll('.archivos-host-check').forEach(c => { c.checked = cb.checked; });
  onArchivosHostCheckChange();
}
function getSelectedArchivosHostUrls(){
  return Array.from(document.querySelectorAll('.archivos-host-check'))
    .filter(c => c.checked)
    .map(c => c.dataset.url);
}
// Copia la(s) URL(s) tildada(s), una por línea si hay más de una.
async function copySelectedArchivosHost(btn){
  const urls = getSelectedArchivosHostUrls();
  if(urls.length === 0) return;
  const text = urls.join('\n');
  try{
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = 'Copiado ✓';
    setTimeout(() => { btn.textContent = original; }, 1500);
  }catch(e){
    prompt('Copiá la(s) URL(s) manualmente:', text);
  }
}
// Con un solo archivo tildado comparte esa URL puntual (como en "Subir
// archivo"); con varios, comparte la lista como texto.
async function shareSelectedArchivosHost(){
  const urls = getSelectedArchivosHostUrls();
  if(urls.length === 0) return;
  try{
    if(urls.length === 1){
      const file = archivosHostFilesByUrl[urls[0]];
      await navigator.share({ title: file && file.media_type === 'video' ? 'Video subido' : 'Imagen subida', url: urls[0] });
    } else {
      await navigator.share({ title: 'Archivos subidos', text: urls.join('\n') });
    }
  }catch(e){
    // El usuario canceló el share sheet u ocurrió otro error: no hacemos nada.
  }
}
// Con un archivo tildado, lo manda directo a "Agregar medio nuevo" con su
// tipo real (imagen o video), como antes. Con 2 o más tildados -- ya
// validados como "todas imágenes, máximo 10" en onArchivosHostCheckChange,
// que es lo que habilita el botón -- arma un carrusel con esas URLs, en el
// mismo orden en que aparecen en la lista.
function useSelectedArchivosHostInMedios(){
  const urls = getSelectedArchivosHostUrls();
  if(urls.length === 0) return;

  if(urls.length === 1){
    const file = archivosHostFilesByUrl[urls[0]];
    if(!file) return;
    useUploadUrlInMedios(file.url, file.media_type);
    return;
  }

  const files = urls.map(u => archivosHostFilesByUrl[u]).filter(Boolean);
  if(files.length !== urls.length || files.some(f => f.media_type === 'video')){
    alert('Un carrusel solo acepta imágenes. Destildá los videos para armarlo con el resto.');
    return;
  }
  if(files.length > 10){
    alert('Un carrusel acepta como máximo 10 imágenes. Destildá algunas.');
    return;
  }
  sendUrlsToMediosCarousel(files.map(f => f.url));
}
// Borra todo lo tildado (una confirmación para todo el lote) y al final
// recarga la lista desde el servidor, que es la fuente de verdad.
async function deleteSelectedArchivosHost(){
  const urls = getSelectedArchivosHostUrls();
  if(urls.length === 0) return;
  const n = urls.length;
  if(!confirm(`¿Eliminar ${n} archivo${n > 1 ? 's' : ''} del servidor? No se puede deshacer. Si ya usaste alguno en "Medios", borrá primero ese medio.`)) return;

  const deleteBtn = document.getElementById('archivosHostDeleteBtn');
  deleteBtn.disabled = true;
  const originalText = deleteBtn.textContent;
  deleteBtn.textContent = 'Eliminando...';

  const errors = [];
  for(const url of urls){
    const filename = url.split('/').pop();
    try{
      const res = await fetch(UPLOAD_ENDPOINT, {
        method: 'POST',
        headers: { 'X-Upload-Token': UPLOAD_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', folder: archivosHostFolder, filename })
      });
      const data = await res.json().catch(() => ({}));
      if(!res.ok || data.error){ throw new Error(data.error || `Error del servidor (${res.status})`); }
    }catch(err){
      errors.push(`${filename}: ${err.message}`);
    }
  }

  deleteBtn.textContent = originalText;
  if(errors.length){
    alert('Algunos archivos no se pudieron eliminar:\n' + errors.join('\n'));
  }
  await loadArchivosHost(); // refresca desde el servidor y resetea la selección
}

export { copySelectedArchivosHost, deleteSelectedArchivosHost, getArchivosHostStorageLimits, getSelectedArchivosHostUrls, loadArchivosHost, onArchivosHostCheckChange, renderArchivosHostRow, renderArchivosHostToolbar, saveArchivosHostLimits, sendUrlsToMediosCarousel, shareSelectedArchivosHost, toggleSelectAllArchivosHost, updateArchivosHostStorageBadge, uploadFilesToArchivosHost, useSelectedArchivosHostInMedios, useUploadUrlInMedios };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.copySelectedArchivosHost = copySelectedArchivosHost;
window.deleteSelectedArchivosHost = deleteSelectedArchivosHost;
window.loadArchivosHost = loadArchivosHost;
window.onArchivosHostCheckChange = onArchivosHostCheckChange;
window.saveArchivosHostLimits = saveArchivosHostLimits;
window.shareSelectedArchivosHost = shareSelectedArchivosHost;
window.toggleSelectAllArchivosHost = toggleSelectAllArchivosHost;
window.uploadFilesToArchivosHost = uploadFilesToArchivosHost;
window.useSelectedArchivosHostInMedios = useSelectedArchivosHostInMedios;
