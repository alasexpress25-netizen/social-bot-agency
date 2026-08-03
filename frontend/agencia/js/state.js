// js/state.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

// ⚠️ Completá con los datos de tu proyecto Supabase (Settings > API)
const SUPABASE_URL = "https://redaqqxoeciycqgjhpbv.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJlZGFxcXhvZWNpeWNxZ2pocGJ2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzgxMDcyMjEsImV4cCI6MjA5MzY4MzIyMX0.HqpOrWPtbYImgy57TafbaB4qriqmq4FI9GIa4Vg9FhI";
// ⚠️ URL pública donde vive frontend/cliente.html. Tiene que ser EXACTA
// (con o sin barra final, según cómo la tengas publicada) y estar agregada
// en Supabase Dashboard → Authentication → URL Configuration → Redirect URLs,
// o el magic link no va a poder volver a la página.
const CLIENT_PORTAL_URL = "https://lavisualmk.alastecno.com/cliente/";
// Valores de RESPALDO por si un cliente todavía no tiene sus propios límites
// cargados (columnas storage_limit_mb / storage_warn_mb en socialbot_clients,
// editables desde "Archivos en Host" > "Ajustar límites de este cliente").
// Con la cuenta gratis de R2 (10GB) repartida en ~10 clientes da ~1GB c/u;
// dejamos margen y arrancamos en 800MB de techo / 700MB de aviso.
const CLIENT_STORAGE_LIMIT_MB = 800;
const CLIENT_STORAGE_WARN_MB = 700;
// ⚠️ 01/08/2026: migrado de Hostinger (publicar/upload.php) a Cloudflare R2
// via Supabase Edge Function, para evitar los 429 de Meta pegandole al
// hosting compartido (ver socialbot_posts / post_scheduler.py). El token
// tiene que matchear EXACTO el secret UPLOAD_TOKEN de esa función.
// La función guarda todo debajo de <folder>/ en el bucket R2, así que acá
// seguimos usando el id del cliente de Supabase como nombre de carpeta
// (misma convención que antes).
const UPLOAD_ENDPOINT = "https://redaqqxoeciycqgjhpbv.supabase.co/functions/v1/r2-media";
const UPLOAD_TOKEN = "accc75453220c8f997e3a7274eadede22e0c3bd347d18303";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { flowType: 'implicit' } // el link va por mail y lo abre OTRO dispositivo (el del cliente),
                                  // así que no puede depender de una llave guardada en este navegador (PKCE)
});
let currentAgencyId = null;
// Mismo orden que _WEEKDAY_NAMES_ES en content_planner.py (Python
// weekday(): 0=lunes..6=domingo) -- usado para mostrar la sugerencia de
// horario de socialbot_suggested_schedule (propuesta 5).
const _WEEKDAY_NAMES_ES_JS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
// Se guarda en localStorage para que, si recargás la página o el service
// worker actualiza la PWA sola, el panel vuelva a abrir con el mismo
// cliente que estabas editando en vez de caer siempre al primero de la
// lista. persistSelectedClientId() se llama cada vez que cambia (ver
// onClientSelectorChange, createClient y loadClients).
const SELECTED_CLIENT_STORAGE_KEY = 'lav_agencia_selected_client';
let selectedClientId = localStorage.getItem(SELECTED_CLIENT_STORAGE_KEY) || null;
 // siempre un cliente puntual — ya no existe el modo "todos"; se define apenas carga la lista de clientes (ver loadClients)

function persistSelectedClientId(){
  if(selectedClientId) localStorage.setItem(SELECTED_CLIENT_STORAGE_KEY, selectedClientId);
  else localStorage.removeItem(SELECTED_CLIENT_STORAGE_KEY);
}
// Guarda, por clientId, el cliente y su primera cuenta conectada (si tiene),
// para poder abrir el modal "Editar cliente" sin volver a pedirle nada a
// Supabase. Se repuebla cada vez que loadClients() renderiza las tarjetas.
let clientsCache = {};
// ---------------------------------------------------------------------------
// Pestaña "Archivos en Host": lista lo que ya está guardado en Hostinger
// (publicar/images/<selectedClientId>/) llamando action=list en upload.php.
// Se dispara sola al abrir la pestaña (ver switchView) y también con el
// botón "Actualizar", por si subieron/borraron algo por otro lado mientras
// el panel estaba abierto.
// ---------------------------------------------------------------------------
// folder de la carga actual (para poder borrar sin depender del selector de
// arriba, por si lo cambian mientras hay archivos tildados) + índice url ->
// {file, folder} para que las acciones en lote no tengan que releer el DOM.
let archivosHostFolder = null;
let archivosHostFilesByUrl = {};
// clientId -> 'week' | 'month'. Por defecto semanal.
const metricPeriod = {};
// clientId -> 'all' | 'facebook' | 'instagram'. Filtro de plataforma en la
// pestaña Métricas (selector Facebook/Instagram/Todas). Por defecto todas.
const metricPlatform = {};
// clientId -> 'country' | 'city'. Actualización 03/08/2026: toggle
// Países/Ciudades del bloque "Principales ubicaciones" (demográficos de
// audiencia) en la pestaña Métricas. Por defecto países.
const metricLocationView = {};
// clientId -> 'list' | 'calendar'. Vista del plan semanal de contenido
// (item "menores" de PROPUESTAS-AGENCIA.md). Por defecto lista, igual que
// siempre -- el calendario es solo un vistazo visual alternativo, de solo
// lectura (para editar/aprobar se sigue usando la vista de lista).
const planViewMode = {};
// ---------------------------------------------------------------------------
// Item 15 (PROPUESTAS-AGENCIA.md): filtro por estado/plataforma + reintentar
// publicacion fallida + link a la publicacion real, en "Ultimas publicaciones"
// de cada cliente. Los posts ya estan cacheados en window.__clientPosts[clientId]
// (se cargan una vez en loadClients), asi que cambiar el filtro solo
// re-renderiza esta lista puntual, sin volver a pegarle a Supabase.
// ---------------------------------------------------------------------------
const PLATFORM_META_AG = {
  facebook:  { label: 'Facebook',  icon: '📘' },
  instagram: { label: 'Instagram', icon: '📷' },
};
// Extrae la etiqueta de etapa (ej: "[listo_para_comprar]") que la IA
// antepone al campo interest, y devuelve el texto limpio + metadata
// visual para pintar el badge.
const LEAD_STAGE_META = {
  listo_para_comprar: { label: 'Listo para comprar', color: '#16a34a', order: 0 },
  potencial:           { label: 'Potencial',          color: '#2563eb', order: 1 },
  interesado:          { label: 'Interesado',         color: '#ca8a04', order: 2 },
  cliente_existente:   { label: 'Cliente existente',  color: '#6b7280', order: 3 },
};
// ---------------------------------------------------------------------------
// Banner de instalación de PWA. En Android/Chrome usamos el evento
// beforeinstallprompt para mostrar nuestro propio banner y disparar el
// prompt nativo. En iOS/Safari ese evento no existe (Apple no lo soporta),
// así que mostramos instrucciones manuales ("Compartir" > "Agregar a inicio").
// El banner no se muestra si la app ya está instalada (modo standalone) ni
// si el usuario ya lo cerró antes (se guarda en localStorage).
// ---------------------------------------------------------------------------
let deferredInstallPrompt = null;

// Setters: en ES modules las bindings importadas son de solo lectura,
// asi que los otros modulos no pueden hacer 'selectedClientId = x'
// directamente -- tienen que llamar a estos setters, que sí pueden
// reasignar la variable porque viven en el mismo modulo que la declara.
function setCurrentAgencyId(v) { currentAgencyId = v; }
function setSelectedClientId(v) { selectedClientId = v; }
function setArchivosHostFolder(v) { archivosHostFolder = v; }
function setArchivosHostFilesByUrl(v) { archivosHostFilesByUrl = v; }
function setDeferredInstallPrompt(v) { deferredInstallPrompt = v; }

export { CLIENT_PORTAL_URL, CLIENT_STORAGE_LIMIT_MB, CLIENT_STORAGE_WARN_MB, LEAD_STAGE_META, PLATFORM_META_AG, SELECTED_CLIENT_STORAGE_KEY, SUPABASE_ANON_KEY, SUPABASE_URL, UPLOAD_ENDPOINT, UPLOAD_TOKEN, _WEEKDAY_NAMES_ES_JS, archivosHostFilesByUrl, archivosHostFolder, clientsCache, currentAgencyId, deferredInstallPrompt, metricLocationView, metricPeriod, metricPlatform, persistSelectedClientId, planViewMode, sb, selectedClientId, setArchivosHostFilesByUrl, setArchivosHostFolder, setCurrentAgencyId, setDeferredInstallPrompt, setSelectedClientId };
