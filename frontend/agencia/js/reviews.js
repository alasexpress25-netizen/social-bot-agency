// js/reviews.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { sb } from "./state.js";
import { loadClients } from "./app.js";

// Punto 9 (propuestas-30-07-2026.md): el bucket 'success-stories' es
// privado, así que en vez de guardar un link fijo pedimos un signed URL
// nuevo cada vez que se toca el botón (dura 1 hora, tiempo de sobra para
// abrirlo o descargarlo). La RLS de storage.objects ya filtra por dueño.
async function openSuccessStory(storagePath){
  const { data, error } = await sb.storage.from('success-stories').createSignedUrl(storagePath, 3600);
  if(error || !data?.signedUrl){ alert('No se pudo generar el link: ' + (error?.message || 'desconocido')); return; }
  window.open(data.signedUrl, '_blank');
}
// ---------------------------------------------------------------------------
// Item 8 de PROPUESTAS-AGENCIA.md: reseñas de Google/Facebook. Guardadas por
// scheduler/reviews_monitor.py con su respuesta sugerida ya generada -- acá
// solo se copia el texto (clipboard) y se marca el estado una vez que Fede
// la publicó a mano (o decidió ignorarla).
// ---------------------------------------------------------------------------
async function copyReviewReply(reviewId){
  const { data } = await sb.from('socialbot_reviews').select('suggested_reply').eq('id', reviewId).maybeSingle();
  const text = data?.suggested_reply || '';
  try {
    await navigator.clipboard.writeText(text);
    alert('Respuesta copiada. Pegala en Facebook/Google Business y publicala vos.');
  } catch (e) {
    prompt('Copiá el texto manualmente:', text);
  }
}
async function setReviewStatus(reviewId, status){
  await sb.from('socialbot_reviews').update({ status }).eq('id', reviewId);
  loadClients();
}

export { copyReviewReply, openSuccessStory, setReviewStatus };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.copyReviewReply = copyReviewReply;
window.openSuccessStory = openSuccessStory;
window.setReviewStatus = setReviewStatus;
