// js/utils.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { LEAD_STAGE_META } from "./state.js";

// Si pegan la URL del logo sin "https://" (ej: "lavisualmk.alastecno.com/...")
// el navegador la trata como ruta relativa rota. La normalizamos antes de
// guardar para que quede bien en la base para todos los que la consuman
// (agencia y cliente), no solo en el preview de este modal.
function normalizeUrl(url){
  if(!url) return url;
  const trimmed = url.trim();
  if(!trimmed) return null;
  if(/^https?:\/\//i.test(trimmed)) return trimmed;
  if(trimmed.startsWith('//')) return 'https:' + trimmed;
  return 'https://' + trimmed;
}
function parseLeadStage(interestRaw) {
  const raw = interestRaw || '';
  const match = raw.match(/^\s*\[([a-z_]+)\]\s*(.*)$/i);
  if (match && LEAD_STAGE_META[match[1]]) {
    return {
      stageKey: match[1],
      stageMeta: LEAD_STAGE_META[match[1]],
      text: match[2] || '—',
    };
  }
  // Leads viejos (sin etiqueta) o etiqueta desconocida: se muestran igual,
  // sin badge, para no romper nada de lo histórico.
  return { stageKey: null, stageMeta: null, text: raw || '—' };
}

export { normalizeUrl, parseLeadStage };
