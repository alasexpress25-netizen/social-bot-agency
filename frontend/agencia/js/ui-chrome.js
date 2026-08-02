// js/ui-chrome.js
// Generado automaticamente al modularizar agencia/index.html.
// No se cambio ninguna logica: solo se movio codigo de lugar y se
// agregaron los import/export necesarios para que funcione como
// modulo ES nativo (<script type="module">).

import { deferredInstallPrompt, selectedClientId, setDeferredInstallPrompt } from "./state.js";
import { loadArchivosHost } from "./archivos-host.js";

// Abre el editor de carruseles (lavisualmk.alastecno.com/crear/) en una
// pestaña nueva, pasándole el cliente ya elegido acá arriba en el
// selector (?client_id=...) para que del otro lado se autoseleccione y
// traiga marca/web/logo/brief solo, sin tener que elegirlo de nuevo.
function goToCrearApp(){
  const base = 'https://lavisualmk.alastecno.com/crear/';
  const url = (selectedClientId && selectedClientId !== 'all')
    ? `${base}?client_id=${encodeURIComponent(selectedClientId)}`
    : base;
  window.open(url, '_blank');
}
// Ya no filtra "todos vs. uno": loadClients() ahora solo trae y renderiza
// al cliente elegido en el selector, así que esto solo asegura que las
// tarjetas (una por pestaña) estén visibles.
function applyClientFilter(){
  document.querySelectorAll('.client-card').forEach(card => { card.style.display = ''; });
}
// Cambia de pestaña en el sidebar (Clientes, Plan, Métricas, Posts, Leads,
// Reseñas, Config. IA, Horarios, Medios, Archivos en Host, Auto-respuesta).
// No vuelve a pedir datos: todas las secciones ya están renderizadas por
// loadClients(), acá solo se muestra una y se ocultan las demás.
function switchView(view){
  document.querySelectorAll('.sidebar .nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view-section').forEach(s => s.style.display = (s.id === 'view-' + view) ? '' : 'none');
  if(view === 'archivoshost') loadArchivosHost();
  closeSidebar(); // en móvil, elegir una sección cierra el menú lateral solo
}
// ---------------------------------------------------------------------------
// Sidebar off-canvas en móvil (solo aplica visualmente <=760px, ver CSS).
// En PC .sidebar nunca tiene "open" ni transform, así que estas funciones
// no cambian nada de su comportamiento actual ahí.
// ---------------------------------------------------------------------------
function toggleSidebar(){
  document.getElementById('sidebarEl').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('open');
  document.getElementById('sidebarPeekTab').classList.toggle('peek-hidden');
}
function closeSidebar(){
  document.getElementById('sidebarEl').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('open');
  document.getElementById('sidebarPeekTab').classList.remove('peek-hidden');
}
// ---------------------------------------------------------------------------
// Altura dinámica del topbar (var --topbar-h). En desktop son 64px fijos,
// pero en pantallas angostas el topbar pasa a 2-3 filas (logo / selector de
// cliente / botones) y su alto real varía según el ancho de pantalla e
// incluso el largo del nombre del cliente elegido. En vez de hardcodear un
// número para el modo móvil, se mide el alto real con JS y ese valor es el
// que usan .layout (padding-top) y .sidebar (top) para no quedar tapados.
// Se vuelve a medir en resize/orientationchange y cuando cambia el
// contenido del topbar (ResizeObserver), por ejemplo al pasar de 1 a 3
// filas al girar el celular.
function updateTopbarHeight(){
  const topbar = document.querySelector('.topbar');
  if(!topbar) return;
  document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
}
updateTopbarHeight();
window.addEventListener('resize', updateTopbarHeight);
window.addEventListener('orientationchange', updateTopbarHeight);
if(window.ResizeObserver){
  new ResizeObserver(updateTopbarHeight).observe(document.querySelector('.topbar'));
}
// Registro del Service Worker (PWA LaVMK Agencia). Va al final, después de
// boot(), para no competir por prioridad de red con la carga inicial de
// datos de Supabase. Si el navegador no soporta SW (raro hoy en día) o el
// registro falla, la app sigue funcionando igual, solo sin modo offline.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('No se pudo registrar el service worker:', err);
    });
  });
}
function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: minimal-ui)').matches
    || window.navigator.standalone === true;
}
function isIos(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
function showInstallBanner(iosMode){
  if(isStandalone()) return;
  if(localStorage.getItem('lav_agencia_install_dismissed') === '1') return;
  const banner = document.getElementById('installBanner');
  if(iosMode){
    document.getElementById('installText').innerText = 'Instalá la app: tocá el botón Compartir de Safari y elegí "Agregar a inicio".';
    document.getElementById('installBtn').style.display = 'none';
  }
  banner.style.display = 'flex';
}
function dismissInstallBanner(){
  document.getElementById('installBanner').style.display = 'none';
  localStorage.setItem('lav_agencia_install_dismissed', '1');
}
async function triggerInstall(){
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  setDeferredInstallPrompt(null);
  document.getElementById('installBanner').style.display = 'none';
}
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  setDeferredInstallPrompt(e);
  showInstallBanner(false);
});
window.addEventListener('appinstalled', () => {
  document.getElementById('installBanner').style.display = 'none';
});
// iOS no dispara beforeinstallprompt: mostramos el banner manual apenas carga,
// salvo que ya esté instalada o el usuario la haya cerrado antes.
if(isIos() && !isStandalone()){
  showInstallBanner(true);
}

export { applyClientFilter, closeSidebar, dismissInstallBanner, goToCrearApp, isIos, isStandalone, showInstallBanner, switchView, toggleSidebar, triggerInstall, updateTopbarHeight };

// Exposicion a window: estas funciones se llaman desde atributos
// onclick="..." embebidos en HTML generado dinamicamente (renderPostsList,
// renderArchivosHostRow, etc). Los modulos ES no exponen sus funciones al
// scope global por default, asi que hace falta este puente explicito.
window.closeSidebar = closeSidebar;
window.dismissInstallBanner = dismissInstallBanner;
window.goToCrearApp = goToCrearApp;
window.switchView = switchView;
window.toggleSidebar = toggleSidebar;
window.triggerInstall = triggerInstall;
