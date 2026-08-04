// js/media.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { sb } from "./state.js";
import { loadClients } from "./app.js";

function toggleMediaTypeFields(selectEl){
  const form = selectEl.closest('form');
  const isCarousel = selectEl.value === 'carousel';
  form.querySelector('[name="url"]').style.display = isCarousel ? 'none' : 'block';
  form.querySelector('[name="carousel_urls"]').style.display = isCarousel ? 'block' : 'none';
  form.querySelector('[name="fb_photo_url"]').style.display = isCarousel ? 'none' : 'block';
}
async function addMedia(e, clientId){
  e.preventDefault();
  const f = new FormData(e.target);
  const mediaType = f.get('media_type');

  if(mediaType === 'carousel'){
    const urls = (f.get('carousel_urls') || '').split('\n').map(u => u.trim()).filter(Boolean);
    if(urls.length < 2 || urls.length > 10){
      alert('Un carrusel necesita entre 2 y 10 imágenes (una URL por línea).');
      return;
    }
    const { data: createdAsset, error } = await sb.from('socialbot_media_assets').insert({
      client_id: clientId,
      url: null,
      media_type: 'carousel',
      caption_override: f.get('caption_override') || null,
      hashtags_override: f.get('hashtags_override') || null,
    }).select();
    if(error){ alert(error.message); return; }
    const assetId = createdAsset[0].id;
    const itemRows = urls.map((url, i) => ({ media_asset_id: assetId, url, position: i }));
    await sb.from('socialbot_carousel_items').insert(itemRows);
  } else {
    const url = f.get('url');
    if(!url){ alert('Cargá la URL del medio.'); return; }

    // Evita cargar el mismo video/imagen dos veces para el mismo cliente
    // (por ejemplo, si tocaste "Agregar medio" sin querer con la misma URL
    // que ya estaba pegada del uso anterior). Comparamos exacto contra lo
    // que ya tiene este cliente en socialbot_media_assets.
    const { data: existing, error: dupError } = await sb
      .from('socialbot_media_assets')
      .select('id')
      .eq('client_id', clientId)
      .eq('url', url)
      .limit(1);
    if(dupError){ alert('No se pudo validar duplicados: ' + dupError.message); return; }
    if(existing && existing.length > 0){
      alert('Ese video/imagen ya está cargado para este cliente. No se puede publicar el mismo archivo dos veces -- usá "Publicar ahora" sobre el medio existente en vez de agregarlo de nuevo.');
      return;
    }

    await sb.from('socialbot_media_assets').insert({
      client_id: clientId,
      url,
      media_type: mediaType,
      caption_override: f.get('caption_override') || null,
      hashtags_override: f.get('hashtags_override') || null,
      fb_photo_url: f.get('fb_photo_url') || null,
    });
  }
  loadClients();
}
async function updateMedia(e, mediaId, clientId, mediaType){
  e.preventDefault();
  const f = new FormData(e.target);
  const manualOrderRaw = (f.get('manual_order') || '').trim();
  const manual_order = manualOrderRaw === '' ? null : parseInt(manualOrderRaw, 10);
  if(manualOrderRaw !== '' && (isNaN(manual_order) || manual_order < 1)){
    alert('El orden manual tiene que ser un número entero de 1 en adelante (o dejalo vacío para que vuelva a la rotación automática).');
    return;
  }

  if(mediaType === 'carousel'){
    const urls = (f.get('carousel_urls') || '').split('\n').map(u => u.trim()).filter(Boolean);
    if(urls.length < 2 || urls.length > 10){
      alert('Un carrusel necesita entre 2 y 10 imágenes (una URL por línea).');
      return;
    }
    await sb.from('socialbot_media_assets').update({
      caption_override: f.get('caption_override') || null,
      hashtags_override: f.get('hashtags_override') || null,
      manual_order,
    }).eq('id', mediaId);
    // Reemplazamos todos los items del carrusel por la lista nueva (mas simple
    // y confiable que tratar de "matchear" cuales cambiaron una por una).
    await sb.from('socialbot_carousel_items').delete().eq('media_asset_id', mediaId);
    const itemRows = urls.map((url, i) => ({ media_asset_id: mediaId, url, position: i }));
    await sb.from('socialbot_carousel_items').insert(itemRows);
  } else {
    const url = f.get('url');
    if(!url){ alert('Cargá la URL del medio.'); return; }
    await sb.from('socialbot_media_assets').update({
      url,
      fb_photo_url: f.get('fb_photo_url') || null,
      caption_override: f.get('caption_override') || null,
      hashtags_override: f.get('hashtags_override') || null,
      manual_order,
    }).eq('id', mediaId);
  }
  loadClients();
}
async function deleteMedia(mediaId, clientId){
  if(!confirm('¿Eliminar este medio? Si tenía un post ya generado usándolo, ese post no se ve afectado, pero el medio ya no se va a poder volver a usar.')) return;
  await sb.from('socialbot_media_assets').delete().eq('id', mediaId);
  loadClients();
}

// ── Vista previa de medio (video/reel o carrusel) ──────────────────────
// Estado del carrusel actualmente abierto en el modal, para poder navegar
// entre imagenes con los botones prev/next.
let mediaPreviewUrls = [];
let mediaPreviewIndex = 0;
let mediaPreviewType = 'video';

function renderMediaPreviewStage(){
  const body = document.getElementById('mediaPreviewBody');
  const url = mediaPreviewUrls[mediaPreviewIndex];
  if(!url){
    body.innerHTML = '<div class="media-preview-error">No hay contenido cargado para este medio todavía.</div>';
    return;
  }
  const isVideo = mediaPreviewType === 'video';
  const navHtml = mediaPreviewUrls.length > 1 ? `
    <button type="button" class="media-preview-nav prev" onclick="mediaPreviewStep(-1)" aria-label="Anterior">‹</button>
    <button type="button" class="media-preview-nav next" onclick="mediaPreviewStep(1)" aria-label="Siguiente">›</button>
  ` : '';
  body.innerHTML = `
    <div class="media-preview-stage">
      ${isVideo
        ? `<video src="${url}" controls autoplay playsinline></video>`
        : `<img src="${url}" alt="Vista previa" />`}
      ${navHtml}
    </div>
    ${mediaPreviewUrls.length > 1 ? `<div class="media-preview-counter">${mediaPreviewIndex + 1} / ${mediaPreviewUrls.length}</div>` : ''}
  `;
}
function mediaPreviewStep(delta){
  if(!mediaPreviewUrls.length) return;
  mediaPreviewIndex = (mediaPreviewIndex + delta + mediaPreviewUrls.length) % mediaPreviewUrls.length;
  renderMediaPreviewStage();
}
function openMediaPreviewModal(mediaType, urls){
  mediaPreviewType = mediaType;
  mediaPreviewUrls = (urls || []).filter(Boolean);
  mediaPreviewIndex = 0;
  document.getElementById('mediaPreviewTitle').textContent = mediaType === 'carousel' ? '🖼️ Carrusel' : (mediaType === 'video' ? '🎬 Video / Reel' : '🖼️ Imagen');
  renderMediaPreviewStage();
  document.getElementById('mediaPreviewModal').classList.add('open');
}
function closeMediaPreviewModal(){
  document.getElementById('mediaPreviewModal').classList.remove('open');
  document.getElementById('mediaPreviewBody').innerHTML = '';
}

export { addMedia, closeMediaPreviewModal, deleteMedia, mediaPreviewStep, openMediaPreviewModal, toggleMediaTypeFields, updateMedia };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.addMedia = addMedia;
window.closeMediaPreviewModal = closeMediaPreviewModal;
window.deleteMedia = deleteMedia;
window.mediaPreviewStep = mediaPreviewStep;
window.openMediaPreviewModal = openMediaPreviewModal;
window.toggleMediaTypeFields = toggleMediaTypeFields;
window.updateMedia = updateMedia;
